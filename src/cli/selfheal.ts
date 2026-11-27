// `dwa selfheal`: the user's side of self-heal. Reports a session or a role that lacks
// something, and lists the fixes that wait and the ones turned down before. Deciding on a fix
// is done on its screen (`dwa wizard fixes`), where the change can be read first.
import { parseArgs } from "node:util";
import { APP_NAME } from "../shared/constants.ts";
import type { FixMemory, FixSummary } from "../shared/protocol.ts";
import { call } from "./client.ts";

const USAGE = `Usage: ${APP_NAME} selfheal <session|role> "<what is wrong>"   Report a gap in a session's or a role's setup
       ${APP_NAME} selfheal --list                             The fixes that wait for your decision
       ${APP_NAME} selfheal --memory                           The fixes you turned down, which are not proposed again
       ${APP_NAME} selfheal --clear-memory [role]              Forget them, for one role or for all`;

export async function selfhealCommand(
  projectRoot: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      list: { type: "boolean" },
      memory: { type: "boolean" },
      "clear-memory": { type: "boolean" },
    },
  });
  if (values.list) {
    const { proposals } = await call<{ proposals: FixSummary[] }>(
      projectRoot,
      "GET",
      "/selfheal/proposals",
    );
    if (proposals.length === 0) console.log("No fix waits for your decision.");
    for (const proposal of proposals) {
      console.log(
        `#${proposal.id}  ${proposal.role || "(no role)"}  ${proposal.summary}  (from ${proposal.reporters.join(", ")})`,
      );
    }
    if (proposals.length > 0) console.log(`Decide with: ${APP_NAME} wizard fixes`);
    return 0;
  }
  if (values.memory) {
    const { memory } = await call<{ memory: FixMemory[] }>(projectRoot, "GET", "/selfheal/memory");
    if (memory.length === 0) console.log("Nothing was turned down.");
    for (const item of memory) {
      console.log(`${item.role || "(no role)"}  ${item.summary}  (your reason: ${item.reason})`);
    }
    return 0;
  }
  if (values["clear-memory"]) {
    const { cleared } = await call<{ cleared: number }>(
      projectRoot,
      "POST",
      "/selfheal/memory/clear",
      { role: positionals[0] },
    );
    console.log(`Forgot ${cleared} turned-down ${cleared === 1 ? "fix" : "fixes"}.`);
    return 0;
  }
  const [target, ...words] = positionals;
  const what = words.join(" ").trim();
  if (!target || !what) {
    console.error(USAGE);
    return 2;
  }
  // Run inside a session it is that session's own report, as its report_gap tool would make it.
  const from = env.DWA_AGENT_ID;
  const receipt = await call<{ id: number; selfheal: string; joined: boolean }>(
    projectRoot,
    "POST",
    "/selfheal/reports",
    from ? { from, what } : { target, what },
  );
  console.log(
    `Report #${receipt.id} is with ${receipt.selfheal}${receipt.joined ? ", which was already looking into this role" : ""}. Its fix waits for you in the top bar (✚), or: ${APP_NAME} wizard fixes`,
  );
  return 0;
}
