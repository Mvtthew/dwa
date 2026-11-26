// Commands that Claude Code itself runs inside every session: on each hook event and every few
// seconds for the status line. They must be fast, never fail and never print anything unexpected,
// because hook output can be fed back to the model. Keep this file's imports minimal.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { daemonSocketPath, runDir } from "../shared/paths.ts";
import {
  approvesOwnTool,
  BLOCKED_FILE,
  blockedReason,
  SKILLS_FILE,
  skillRefusal,
} from "../shared/tools.ts";

type Env = Record<string, string | undefined>;

/** Sends to the daemon and returns its answer, or null when there is none. */
async function post(env: Env, path: string, body: unknown): Promise<unknown> {
  const projectRoot = env.DWA_PROJECT;
  if (!projectRoot) return null;
  try {
    const response = await fetch(`http://localhost${path}`, {
      unix: env.DWA_SOCKET || daemonSocketPath(projectRoot),
      method: "POST",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    return await response.json();
  } catch {
    // The daemon is down or slow. The session must carry on regardless.
    return null;
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Whether a tool call is refused, from the list the daemon keeps in the session's run folder.
 * Read here and not asked from the daemon, so a tool that was switched off stays off while
 * the daemon restarts. `undefined` when there is no list, so the daemon's answer counts; a
 * list that is there but cannot be read refuses the call.
 */
export function localVerdict(
  projectRoot: string,
  agentId: string,
  tool: string,
): string | null | undefined {
  const file = join(runDir(projectRoot), "agents", agentId, BLOCKED_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const blocks = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(blocks)) throw new Error("not a list");
    return blockedReason(
      tool,
      blocks.filter((item) => typeof item === "string"),
    );
  } catch {
    return `The list of tools switched off for this session could not be read (${file}), so the call is refused. Tell the user.`;
  }
}

/**
 * Whether a call of the Skill tool is refused: the skill is not in the list written for the
 * session when it was started. Null when it may go ahead, and when there is no list (a session
 * started before dwa wrote one). A list that cannot be read refuses the call.
 */
export function skillVerdict(projectRoot: string, agentId: string, input: unknown): string | null {
  const skill = (input as { tool_input?: { skill?: unknown } } | null)?.tool_input?.skill;
  if (typeof skill !== "string") return null;
  const file = join(runDir(projectRoot), "agents", agentId, SKILLS_FILE);
  if (!existsSync(file)) return null;
  try {
    const allowed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(allowed)) throw new Error("not a list");
    return skillRefusal(
      skill,
      allowed.filter((item) => typeof item === "string"),
    );
  } catch {
    return `The list of skills this session was given could not be read (${file}), so the call is refused. Tell the user.`;
  }
}

/**
 * `dwa hook <event>`: forwards the event JSON from stdin to the daemon. Prints nothing, with
 * two exceptions, both in the form Claude Code reads: on `PreToolUse` the refusal of a tool that
 * was switched off for the session after it started or of a skill the session was not given, and on `PermissionRequest` the approval of
 * one of dwa's own tools in plan mode (`approvesOwnTool`). A refused call never gets that far.
 */
export async function hookCommand(
  event: string | undefined,
  env: Env = process.env,
): Promise<number> {
  const agentId = env.DWA_AGENT_ID;
  if (!event || !agentId) return 0;
  const input = parse(await Bun.stdin.text());
  const tool = (input as { tool_name?: unknown } | null)?.tool_name;
  const local =
    event === "PreToolUse" && typeof tool === "string" && env.DWA_PROJECT
      ? localVerdict(env.DWA_PROJECT, agentId, tool)
      : undefined;
  const reply = (await post(env, "/hook", { agentId, event, input })) as { deny?: unknown } | null;
  // The session's own list decides; the daemon's answer only when there is no list.
  const blocked = local !== undefined ? local : typeof reply?.deny === "string" ? reply.deny : null;
  const deny =
    blocked ||
    (event === "PreToolUse" && tool === "Skill" && env.DWA_PROJECT
      ? skillVerdict(env.DWA_PROJECT, agentId, input)
      : null);
  if (event === "PreToolUse" && deny) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: deny,
        },
      }),
    );
  } else if (event === "PermissionRequest" && approvesOwnTool(input)) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
      }),
    );
  }
  return 0;
}

/**
 * `dwa statusline`: sends the statusline JSON to the daemon and prints the one line the daemon
 * answers with (the session's role, model, context and cost). Claude Code keeps a row for the
 * status line even when nothing is printed, so the row is used; the user's own status line is
 * not carried into the workspace. Without a daemon nothing is printed.
 */
export async function statuslineCommand(env: Env = process.env): Promise<number> {
  const data = parse(await Bun.stdin.text());
  const agentId = env.DWA_AGENT_ID;
  if (!agentId) return 0;
  const answer = (await post(env, "/statusline", { agentId, data })) as { line?: unknown } | null;
  // One line only: more would take rows from the session.
  const line = typeof answer?.line === "string" ? answer.line.split("\n")[0] : "";
  if (line) console.log(line);
  return 0;
}

/** How long the mailbox keeps retrying when the daemon cannot be reached. */
const MAILBOX_RETRY_LIMIT_MS = 60 * 60 * 1000;

/**
 * `dwa mailbox`: the session's mailbox hook. It runs in the background (`asyncRewake`) and waits
 * at the daemon until a message for this agent arrives, then prints it to stderr and exits with
 * code 2, which wakes the session with that text. Exits quietly when a newer hook takes over.
 */
export async function mailboxCommand(env: Env = process.env): Promise<number> {
  const agentId = env.DWA_AGENT_ID;
  const projectRoot = env.DWA_PROJECT;
  if (!agentId || !projectRoot) return 0;
  const socket = env.DWA_SOCKET || daemonSocketPath(projectRoot);
  const giveUpAt = Date.now() + MAILBOX_RETRY_LIMIT_MS;

  while (true) {
    try {
      const response = await fetch("http://localhost/mailbox/wait", {
        unix: socket,
        method: "POST",
        body: JSON.stringify({ agentId }),
      });
      if (!response.ok) return 0;
      const { messages } = (await response.json()) as { messages?: string[] };
      if (!messages || messages.length === 0) return 0;
      // No trailing newline: Claude Code wraps this text in its own reminder block.
      process.stderr.write(messages.join("\n\n"));
      return 2;
    } catch {
      // The daemon is restarting or gone. Messages are kept there, so try again for a while.
      if (Date.now() > giveUpAt) return 0;
      await Bun.sleep(2000);
    }
  }
}
