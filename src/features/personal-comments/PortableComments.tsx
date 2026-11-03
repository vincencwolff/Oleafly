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
              <p key={messageId} className="whitespace-pre-wrap break-words">
                <strong>{message.author}</strong> {message.body}
              </p>
            ))}
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
                onClick={async () => {
                  if (!projectId) return;
                  setBusy(true);
                  try {
                    const log = await invoke<string>("texpile_comments", {
                      projectId,
                      events: texpileEvents(file, note),
                    });
                    if (typeof log !== "string") throw new Error("Invalid Texpile comment log");
                    setResult({ projectId, log });
                    setError(false);
                  } catch {
                    setError(true);
                  } finally {
                    setBusy(false);
                  }
                }}
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
