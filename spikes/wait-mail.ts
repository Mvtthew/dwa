// Spike S3: an `asyncRewake` hook used as a mailbox. It waits until a file appears in
// spikes/out/mail-<agent>/, prints the message to stderr and exits 2, which should wake
// the session even when it is idle. One waiter per agent; extra invocations exit at once.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.env.DWA_SPIKE_OUT ?? join(import.meta.dir, "out");
const agent = process.env.DWA_AGENT_ID ?? "?";
const mailDir = join(outDir, `mail-${agent}`);
const lock = join(outDir, `waiter-${agent}.pid`);
mkdirSync(mailDir, { recursive: true });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (existsSync(lock) && alive(Number(readFileSync(lock, "utf8")))) process.exit(0);
writeFileSync(lock, String(process.pid));

while (true) {
  const files = readdirSync(mailDir).sort();
  if (files.length > 0) {
    const messages = files.map((file) => {
      const path = join(mailDir, file);
      const text = readFileSync(path, "utf8");
      rmSync(path);
      return text;
    });
    rmSync(lock, { force: true });
    console.error(`[dwa] ${messages.length} new message(s):\n${messages.join("\n---\n")}`);
    process.exit(2);
  }
  await Bun.sleep(500);
}
