import { Pencil, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { loadTypstParser } from "@oleafly/editor/typst";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useFilesStore } from "@/store/files";
import { usePersonalComments } from "./store";
import { readTexpileComments, texpileEvents } from "./texpile";

export function PortableComments() {
  const german = useTranslation().i18n.resolvedLanguage?.startsWith("de");
  const projectId = useFilesStore((state) => state.projectId);
  const path = useFilesStore((state) => state.activePath);
  const source = useFilesStore((state) => (path ? state.files[path]?.content : undefined));
  const files = usePersonalComments((state) => state.data.files);
  const showResolved = usePersonalComments((state) => state.showResolved);
  const [result, setResult] = useState<{ projectId: string; log: string }>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string }>();
  const [parsed, setParsed] = useState<{ source: string; comments: string[] }>();

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        const log = await invoke<string>("texpile_comments", { projectId });
        if (active && request === generation) {
          if (typeof log !== "string") throw new Error("Invalid Texpile comment log");
          setResult({ projectId, log });
          setError(false);
        }
      } catch {
        if (active && request === generation) setError(true);
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [projectId]);

  useEffect(() => {
    if (!path?.toLowerCase().endsWith(".typ") || source === undefined) return;
    let active = true;
    void loadTypstParser()
      .then((parser) => {
        if (!active) return;
        const comments: string[] = [];
        parser.parse(source).iterate({
          enter(node) {
            if (node.name === "LineComment" || node.name === "BlockComment") {
              comments.push(source.slice(node.from, node.to));
            }
          },
        });
        setParsed({ source, comments });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [path, source]);

  async function save(events: object[]) {
    if (!projectId || busy) return false;
    setBusy(true);
    try {
      const log = await invoke<string>("texpile_comments", { projectId, events });
      if (typeof log !== "string") throw new Error("Invalid Texpile comment log");
      setResult({ projectId, log });
      setError(false);
      return true;
    } catch {
      setError(true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function append(event: object) {
    return save([{ v: 1, at: new Date().toISOString(), by: "Oleafly", ...event }]);
  }
  const threads = result && result.projectId === projectId ? readTexpileComments(result.log) : [];
  const exported = new Set(threads.map(([id]) => id));
  const sourceComments =
    path?.toLowerCase().endsWith(".typ") && parsed?.source === source ? (parsed?.comments ?? []) : [];

  return (
    <section className="space-y-2 text-xs">
      <h3 className="font-medium">Texpile</h3>
      {error && (
        <p role="alert">
          {german
            ? "Texpile-Kommentare konnten nicht gelesen oder gespeichert werden."
            : "Could not read or save Texpile comments."}
        </p>
      )}
      {threads
        .filter(([, thread]) => showResolved || !thread.resolved)
        .map(([id, thread]) => (
          <article key={id} className="space-y-1 rounded-md border p-2">
            <p className="break-all text-muted-foreground">
              {thread.path}
              {thread.resolved ? " ✓" : ""}
            </p>
            {thread.quote && (
              <blockquote className="whitespace-pre-wrap break-words">{thread.quote}</blockquote>
            )}
            {[...thread.messages].map(([messageId, message]) => (
              <div key={messageId} className="space-y-1">
                <div className="flex items-center justify-between gap-1">
                  <strong>{message.author}</strong>
                  <div className="flex">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      disabled={busy}
                      aria-label={german ? "Kommentar bearbeiten" : "Edit comment"}
                      onClick={() => setEditing({ id: messageId, body: message.body })}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      disabled={busy}
                      aria-label={german ? "Kommentar löschen" : "Delete comment"}
                      onClick={() => {
                        if (
                          window.confirm(
                            german
                              ? "Kommentar im gemeinsamen Projekt löschen?"
                              : "Delete this comment from the shared project?",
                          )
                        ) {
                          void append({ t: "delete-message", message: messageId });
                        }
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                {editing?.id === messageId ? (
                  <form
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (
                        editing.body.trim() &&
                        (await append({ t: "edit", message: messageId, body: editing.body.trim() }))
                      ) {
                        setEditing(undefined);
                      }
                    }}
                  >
                    <textarea
                      className="w-full rounded border bg-transparent p-1"
                      aria-label={german ? "Kommentartext" : "Comment text"}
                      value={editing.body}
                      onChange={(event) => setEditing({ id: messageId, body: event.target.value })}
                    />
                    <Button size="sm" type="submit" disabled={busy || !editing.body.trim()}>
                      {german ? "Speichern" : "Save"}
                    </Button>
                    <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(undefined)}>
                      {german ? "Abbrechen" : "Cancel"}
                    </Button>
                  </form>
                ) : (
                  <p className="whitespace-pre-wrap break-words">{message.body}</p>
                )}
              </div>
            ))}
            <form
              className="flex items-end gap-1"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const body = String(new FormData(form).get("reply") ?? "").trim();
                if (body && (await append({ t: "reply", thread: id, id: crypto.randomUUID(), body })))
                  form.reset();
              }}
            >
              <textarea
                required
                name="reply"
                rows={1}
                className="min-w-0 flex-1 rounded border bg-transparent p-1"
                aria-label={german ? "Antworttext" : "Reply text"}
                placeholder={german ? "Antwort schreiben" : "Write a reply"}
              />
              <Button size="sm" type="submit" disabled={busy}>
                {german ? "Antworten" : "Reply"}
              </Button>
            </form>
          </article>
        ))}
      {files.flatMap((file) =>
        file.notes
          .filter((note) => !exported.has(note.id) && (showResolved || !note.resolved))
          .map((note) => (
            <div key={note.id} className="flex flex-wrap items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={!projectId || busy}
                onClick={() => void save(texpileEvents(file, note))}
              >
                {german ? "Für Texpile kopieren" : "Copy for Texpile"} — {note.body.slice(0, 80)}
              </Button>
            </div>
          )),
      )}
      {sourceComments.length > 0 && (
        <>
          <h3 className="font-medium">{german ? "Quelltextkommentare" : "Source comments"}</h3>
          <ul className="space-y-1">
            {sourceComments.map((comment, index) => (
              <li key={index} className="whitespace-pre-wrap break-words rounded-md border p-2">
                {comment}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
