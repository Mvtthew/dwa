// Spike S11: a hook command that records its input in out/s11/hooks.jsonl and answers by the
// rules in out/s11/rules.json, which is read on every call so it can change between turns.
// A rule: { event, tool?, match?, json?, text?, stderr?, exit? }. `match` is a substring of the
// JSON of tool_input; `json` is printed as JSON on stdout, `text` as it is. First match wins.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

type Rule = {
  event: string;
  tool?: string;
  match?: string;
  json?: unknown;
  text?: string;
  stderr?: string;
  exit?: number;
};
const out = join(import.meta.dir, "..", "out", "s11");
const input = JSON.parse(await Bun.stdin.text());
const file = Bun.file(join(out, "rules.json"));
const rules: Rule[] = (await file.exists()) ? await file.json() : [];
const rule = rules.find(
  (r) =>
    r.event === input.hook_event_name &&
    (!r.tool || r.tool === input.tool_name) &&
    (!r.match || JSON.stringify(input.tool_input ?? {}).includes(r.match)),
);
const printed = rule?.json !== undefined ? JSON.stringify(rule.json) : (rule?.text ?? "");
appendFileSync(
  join(out, "hooks.jsonl"),
  `${JSON.stringify({ at: new Date().toISOString(), tag: process.argv[2] ?? "", printed, exit: rule?.exit ?? 0, input })}\n`,
);
if (printed) console.log(printed);
if (rule?.stderr) console.error(rule.stderr);
process.exit(rule?.exit ?? 0);
