// S7: records every mouse event and key a program in a tmux popup receives, one JSON line each.
// Usage: bun spikes/s7/log-mouse.ts <log file>. Ends on "q".
import { appendFileSync, writeFileSync } from "node:fs";
import { BoxRenderable, createCliRenderer, type MouseEvent } from "@opentui/core";

const log = process.argv[2] ?? "spikes/out/s7/events.jsonl";
writeFileSync(log, "");
const note = (record: Record<string, unknown>) =>
  appendFileSync(log, `${JSON.stringify(record)}\n`);

const renderer = await createCliRenderer({ exitOnCtrlC: true, enableMouseMovement: false });
const box = new BoxRenderable(renderer, { id: "all", width: "100%", height: "100%", border: true });
const mouse = (kind: string) => (event: MouseEvent) =>
  note({ kind, x: event.x, y: event.y, button: event.button, scroll: event.scroll?.direction });
box.onMouseDown = mouse("down");
box.onMouseUp = mouse("up");
box.onMouseDrag = mouse("drag");
box.onMouseDragEnd = mouse("dragEnd");
box.onMouseScroll = mouse("scroll");
renderer.root.add(box);
note({ kind: "size", width: renderer.width, height: renderer.height });
renderer.keyInput.on("keypress", (key) => {
  note({ kind: "key", name: key.name });
  if (key.name === "q") {
    renderer.destroy();
    process.exit(0);
  }
});
