import { APP_NAME } from "../../shared/constants.ts";
import type {
  Launch,
  LaunchRequest,
  McpServerCommand,
  Provider,
  SessionCommands,
} from "../provider.ts";
import { workspacePrompt } from "./prompt.ts";

/**
 * The mailbox hook waits for as long as the session lives. Claude Code still enforces a timeout
 * on it, so it is set to 30 days; the paste fallback covers a session that outlives it.
 */
const MAILBOX_TIMEOUT_SECONDS = 30 * 24 * 60 * 60;

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
  if (request.mcpConfigPath) argv.push("--mcp-config", request.mcpConfigPath);
  if (request.systemPrompt) argv.push("--append-system-prompt", request.systemPrompt);
  if (request.role) argv.push("--agent", request.role);
  if (request.task) argv.push(request.task);
  return { argv, env: { ...NO_TOOL_TIMEOUT_ENV, ...request.profile.env } };
}

/** Events after which a session may sit idle, so the mailbox hook is (re)armed on them. */
const MAILBOX_EVENTS: readonly string[] = ["SessionStart", "Stop"];

/**
 * Settings passed with `--settings`: hooks for state, the mailbox hook for incoming messages
 * (an `asyncRewake` hook, which wakes even an idle session; see docs/spikes.md, S3), a
 * statusline command for telemetry, and permission to use the dwa tools without a prompt.
 */
export function buildClaudeSettings(commands: SessionCommands) {
  const mailbox = {
    type: "command",
    command: commands.mailbox,
    asyncRewake: true,
    timeout: MAILBOX_TIMEOUT_SECONDS,
  };
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      [
        {
          hooks: [
            { type: "command", command: `${commands.hook} ${event}`, timeout: 10 },
            ...(MAILBOX_EVENTS.includes(event) ? [mailbox] : []),
          ],
        },
      ],
    ]),
  );
  return {
    hooks,
    statusLine: { type: "command", command: commands.statusline },
    permissions: { allow: [`mcp__${APP_NAME}`] },
  };
}

export function buildClaudeMcpConfig(server: McpServerCommand) {
  return { mcpServers: { [APP_NAME]: { type: "stdio", ...server } } };
}

export const claudeProvider: Provider = {
  id: "claude",
  buildLaunch: buildClaudeLaunch,
  buildSettings: buildClaudeSettings,
  buildMcpConfig: buildClaudeMcpConfig,
  systemPrompt: workspacePrompt,
};
