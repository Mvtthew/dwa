/**
 * Variables a running Claude Code session (or tmux) sets for its own children. If dwa is started
 * from inside such a session they must not leak into the sessions it launches. Settings a user
 * exports on purpose, such as CLAUDE_CONFIG_DIR, are kept.
 */
const SESSION_ONLY = new Set([
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SHELL",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_CHILD_NOTES_DIR",
  "TMUX",
  "TMUX_PANE",
]);

export function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || SESSION_ONLY.has(key)) continue;
    result[key] = value;
  }
  return result;
}

/**
 * What a spawn request made with the CLI carries when the command runs inside a session of the
 * workspace (its shell has the session's `DWA_AGENT_ID`): the same as the `spawn_agent` tool
 * sends, so the new session can only be narrower than its role and owes its result to the
 * caller. The user's own terminal, the workspace's shell pane and the popups have no such
 * variable. This keeps a session from going around `spawn_agent` by accident; it is not a
 * barrier against one that sets out to, which can change its environment.
 */
export function spawnOrigin(
  env: Record<string, string | undefined>,
): { from: string; narrowOnly: true } | Record<string, never> {
  const from = env.DWA_AGENT_ID;
  return from ? { from, narrowOnly: true } : {};
}
