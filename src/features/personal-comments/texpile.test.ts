import { expect, test } from "vitest";
import { readTexpileComments, texpileEvents } from "./texpile";

test("exports a selected quote and reads replies, edits, moves and resolution", () => {
  const note = {
    id: "first",
    quote: "Wörter",
    body: "Überarbeiten",
    range: { from: 3, to: 9 },
    resolved: true,
  };
  const events = texpileEvents({ path: "part/main.typ", text: "😀 Wörter danach", notes: [note] }, note);
  expect(events[0]).toMatchObject({ anchor: { start: 3, end: 9, quote: "Wörter", prefix: "😀 " } });
  const log = [
    ...events,
    { v: 1, t: "reply", id: "second", thread: "first", by: "Ada", body: "OK" },
    { v: 1, t: "edit", message: "second", body: "Fertig" },
    { v: 1, t: "move", from: "part", to: "chapter" },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  const [[id, thread]] = readTexpileComments(log);
  expect(id).toBe("first");
  expect(thread).toMatchObject({ path: "chapter/main.typ", quote: "Wörter", resolved: true });
  expect(thread.messages.get("second")).toEqual({ author: "Ada", body: "Fertig" });
  expect(readTexpileComments(log + '\n{"v":1,"t":"delete","thread":"first"}')).toEqual([]);
});
