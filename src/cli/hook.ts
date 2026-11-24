// Commands that Claude Code itself runs inside every session: on each hook event and every few
// seconds for the status line. They must be fast, never fail and never print anything unexpected,
// because hook output can be fed back to the model. Keep this file's imports minimal.
import { homedir } from "node:os";
import { join } from "node:path";
import { daemonSocketPath } from "../shared/paths.ts";

type Env = Record<string, string | undefined>;

async function post(env: Env, path: string, body: unknown): Promise<void> {
  const projectRoot = env.DWA_PROJECT;
  if (!projectRoot) return;
  try {
    await fetch(`http://localhost${path}`, {
      unix: env.DWA_SOCKET || daemonSocketPath(projectRoot),
      method: "POST",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // The daemon is down or slow. The session must carry on regardless.
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `dwa hook <event>`: forwards the event JSON from stdin to the daemon. Prints nothing. */
export async function hookCommand(
  event: string | undefined,
  env: Env = process.env,
): Promise<number> {
  const agentId = env.DWA_AGENT_ID;
  if (!event || !agentId) return 0;
  const input = parse(await Bun.stdin.text());
  await post(env, "/hook", { agentId, event, input });
  return 0;
}

/** The statusline command the user configured for Claude Code, if any. */
export async function userStatuslineCommand(env: Env = process.env): Promise<string | null> {
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    const settings = parse(await Bun.file(join(configDir, "settings.json")).text()) as {
      statusLine?: { command?: unknown };
    } | null;
    const command = settings?.statusLine?.command;
    return typeof command === "string" && command.trim() !== "" ? command : null;
  } catch {
    return null;
  }
}

/** A plain line for users without a status line of their own. */
export function defaultStatusline(data: unknown): string {
  const input = (data ?? {}) as {
    model?: { display_name?: string };
    context_window?: { used_percentage?: number };
  };
  const parts = [input.model?.display_name, `ctx ${input.context_window?.used_percentage ?? "?"}%`];
  return parts.filter(Boolean).join(" · ");
}

/**
 * `dwa statusline`: sends the statusline JSON to the daemon, then shows the user's own status
 * line (dwa's per-session settings replace it, so it is run from here), or a plain one.
 */
export async function statuslineCommand(env: Env = process.env): Promise<number> {
  const text = await Bun.stdin.text();
  const data = parse(text);
  const agentId = env.DWA_AGENT_ID;
  const sent = agentId ? post(env, "/statusline", { agentId, data }) : Promise.resolve();

  const command = await userStatuslineCommand(env);
  let output = "";
  if (command) {
    try {
      const proc = Bun.spawn(["sh", "-c", command], {
        stdin: new Blob([text]),
        stdout: "pipe",
        stderr: "ignore",
      });
      output = await new Response(proc.stdout).text();
    } catch {
      output = "";
    }
  }
  process.stdout.write(output.trim() === "" ? `${defaultStatusline(data)}\n` : output);
  await sent;
  return 0;
}
