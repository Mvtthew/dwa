// Spike S13: the resize hook as dwa installs it, held back by a flag on the window.
// Usage: bun spikes/s13/hook.ts <a script that logs its arguments> <its log file>
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmuxQuote } from "../../src/tmux/conf.ts";
import { installResizeHook, relayoutTaken, WORKSPACE_TARGET } from "../../src/tmux/layout.ts";

const [script = "", log = ""] = process.argv.slice(2);
const T = join(import.meta.dir, "../t.sh");
const run = async (args: string[]) => {
  const p = Bun.spawnSync([T, ...args]);
  if (p.exitCode !== 0) throw new Error(`${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
};
const fired = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
rmSync(log, { force: true });
await run(["kill-server"]).catch(() => undefined);
await run([
  "new-session",
  "-d",
  "-s",
  "dwa",
  "-n",
  "workspace",
  "-x",
  "100",
  "-y",
  "30",
  "sleep 999",
]);
await run(["new-window", "-d", "-t", "dwa:", "-n", "pool", "sleep 999"]);
await installResizeHook(run, `sh ${tmuxQuote(script)}`);
console.log(await run(["show-hooks", "-w", "-t", WORKSPACE_TARGET]));
for (const width of [110, 120, 130])
  await run(["resize-window", "-t", WORKSPACE_TARGET, "-x", String(width), "-y", "30"]);
await Bun.sleep(500);
console.log(`3 resizes: ${fired().length} run(s): ${fired().join(" | ")}`);
await run(["resize-window", "-t", "=dwa:pool", "-x", "90", "-y", "30"]);
await relayoutTaken(run);
await run(["resize-window", "-t", WORKSPACE_TARGET, "-x", "140", "-y", "30"]);
await Bun.sleep(500);
console.log(`flag cleared, 1 resize: ${fired().length} run(s) in all`);
await run(["resize-pane", "-Z", "-t", WORKSPACE_TARGET]).catch((error) =>
  console.log(`zoom: ${error.message}`),
);
await run(["split-window", "-d", "-t", WORKSPACE_TARGET, "sleep 999"]);
await run(["resize-pane", "-Z", "-t", WORKSPACE_TARGET]);
console.log(
  `zoom by window target: ${await run(["display-message", "-p", "-t", WORKSPACE_TARGET, "#{window_zoomed_flag}"])}`,
);
await run(["kill-server"]);
