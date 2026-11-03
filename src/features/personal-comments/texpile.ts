import type { CommentFile, PersonalComment } from "./model";

export function texpileEvents(file: CommentFile, note: PersonalComment) {
  const base = { v: 1, by: "Oleafly", at: new Date().toISOString() };
  const start = note.range?.from ?? 0;
  const end = note.range?.to ?? 0;
  return [
    {
      ...base,
      t: "open",
      id: note.id,
      file: file.path,
      body: note.body,
      anchor: {
        quote: note.range ? file.text.slice(start, end) : note.quote,
        prefix: note.range ? file.text.slice(Math.max(0, start - 32), start) : "",
        suffix: note.range ? file.text.slice(end, end + 32) : "",
        start,
        end,
      },
    },
    ...(note.resolved ? [{ ...base, t: "resolve", thread: note.id, resolved: true }] : []),
  ];
}

export function readTexpileComments(log: string) {
  const threads = new Map<
    string,
    {
      path: string;
      quote: string;
      resolved: boolean;
      messages: Map<string, { author: string; body: string }>;
    }
  >();
  for (const line of log.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || event.v !== 1) continue;
    const thread = threads.get(event.thread);
    switch (event.t) {
      case "open":
        if (
          typeof event.id === "string" &&
          typeof event.file === "string" &&
          typeof event.anchor?.quote === "string" &&
          typeof event.body === "string" &&
          !threads.has(event.id)
        ) {
          threads.set(event.id, {
            path: event.file,
            quote: event.anchor.quote,
            resolved: false,
            messages: new Map([[event.id, { author: String(event.by ?? ""), body: event.body }]]),
          });
        }
        break;
      case "reply":
        if (typeof event.id === "string" && typeof event.body === "string") {
          thread?.messages.set(event.id, { author: String(event.by ?? ""), body: event.body });
        }
        break;
      case "resolve":
        if (thread && typeof event.resolved === "boolean") thread.resolved = event.resolved;
        break;
      case "delete":
        threads.delete(event.thread);
        break;
      case "edit":
      case "delete-message":
        for (const item of threads.values()) {
          const message = item.messages.get(event.message);
          if (!message) continue;
          if (event.t === "delete-message") item.messages.delete(event.message);
          else if (typeof event.body === "string") message.body = event.body;
          break;
        }
        break;
      case "anchor":
        if (thread && typeof event.anchor?.quote === "string") {
          thread.quote = event.anchor.quote;
          if (typeof event.file === "string") thread.path = event.file;
        }
        break;
      case "move":
        if (typeof event.from === "string" && typeof event.to === "string") {
          for (const item of threads.values()) {
            if (item.path === event.from || item.path.startsWith(event.from + "/")) {
              item.path = event.to + item.path.slice(event.from.length);
            }
          }
        }
        break;
    }
  }
  return [...threads].filter(([, thread]) => thread.messages.size && /\.typ$/i.test(thread.path));
}
