// Spike S8: the hook of every session. Appends each call to out/s8/hooks.jsonl. On `Stop` it
// blocks the stop while out/s8/<tag>.block has entries: the file holds seconds to wait before
// each block ("0 3" = block at once, then block the next stop after 3 s), one entry used per stop.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = join(import.meta.dir, "..", "out", "s8");
const tag = process.argv[2] ?? "";
const input = JSON.parse(await Bun.stdin.text());
appendFileSync(
  join(out, "hooks.jsonl"),
  `${JSON.stringify({
    at: new Date().toISOString(),
    tag,
    event: input.hook_event_name,
    session_id: input.session_id,
    source: input.source,
    stop_hook_active: input.stop_hook_active,
    transcript: input.transcript_path,
  })}\n`,
);

if (input.hook_event_name === "Stop") {
  const file = join(out, `${tag}.block`);
  const waits = existsSync(file) ? readFileSync(file, "utf8").split(/\s+/).filter(Boolean) : [];
  const wait = waits.shift();
  if (wait !== undefined) {
    writeFileSync(file, waits.join(" "));
    await Bun.sleep(Number(wait) * 1000);
    console.error("Call the ping tool of the probe MCP server now, or reply NO TOOL.");
    process.exit(2);
  }
}
