// Spike S5: a statusline command that records each call and prints nothing (or a line with "loud").
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const outDir = process.env.DWA_SPIKE_OUT ?? join(import.meta.dir, "..", "out", "s5");
mkdirSync(outDir, { recursive: true });
await Bun.stdin.text();
appendFileSync(
  join(outDir, `status-${process.argv[2] ?? "x"}.log`),
  `${new Date().toISOString()}\n`,
);
if (process.argv[3] === "loud") console.log("S5-STATUSLINE");
