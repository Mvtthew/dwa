import type { Launch, LaunchRequest, Provider, SessionCommands } from "../provider.ts";

/**
 * Keeps a blocking `ask` tool call open: no move to a background task, no idle abort, and the
 * largest wall-clock limit. See docs/spikes.md (S4).
 */
const NO_TOOL_TIMEOUT_ENV = {
  CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0",
  CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0",
  MCP_TOOL_TIMEOUT: "2000000000",
};

/** Hook events dwa listens to. `reduceHook` in src/daemon/activity.ts gives them meaning. */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "PreCompact",
  "PostCompact",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;

/**
 * Builds the command for a native interactive Claude Code session. The executable comes from the
 * profile and is never assumed to be called `claude`.
 */
export function buildClaudeLaunch(request: LaunchRequest): Launch {
  const argv = [
    request.profile.command,
    ...request.profile.args,
    "--session-id",
    request.sessionId,
    "--name",
    request.name,
  ];
  if (request.settingsPath) argv.push("--settings", request.settingsPath);
  if (request.role) argv.push("--agent", request.role);
  if (request.task) argv.push(request.task);
  return { argv, env: { ...NO_TOOL_TIMEOUT_ENV, ...request.profile.env } };
}

/** Settings passed with `--settings`: hooks for state and a statusline command for telemetry. */
export function buildClaudeSettings(commands: SessionCommands) {
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      [{ hooks: [{ type: "command", command: `${commands.hook} ${event}`, timeout: 10 }] }],
    ]),
  );
  return {
    hooks,
    statusLine: { type: "command", command: commands.statusline },
  };
}

export const claudeProvider: Provider = {
  id: "claude",
  buildLaunch: buildClaudeLaunch,
  buildSettings: buildClaudeSettings,
};
