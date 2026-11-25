import { APP_NAME } from "../../shared/constants.ts";
import type { ResolvedSession } from "../../shared/roles.ts";
import type {
  Launch,
  LaunchRequest,
  McpServerCommand,
  Provider,
  SessionCommands,
  SessionIsolation,
} from "../provider.ts";
import { sessionPrompt } from "./prompt.ts";

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
  const { session } = request;
  const argv = [
    request.profile.command,
    ...request.profile.args,
    // Without the "user" source the session does not load the user's own settings, and with
    // them their hooks, status line, plugins, skills, commands and agents. See docs/spikes.md (S5).
    "--setting-sources",
    "project,local",
  ];
  // These two take a list of values, so they come before an option that ends the list and
  // never right before the task.
  if (session.tools) argv.push("--tools", allowedTools(session).join(","));
  if (session.denyTools.length > 0) argv.push("--disallowedTools", session.denyTools.join(","));
  // A restart continues the conversation. The session id cannot be given next to it, and
  // without the snapshot switch the system prompt of the first start would be used again,
  // so a changed role prompt would not arrive. See docs/spikes.md (S6).
  if (request.resume) argv.push("--resume", request.sessionId, "--system-prompt-snapshot", "off");
  else argv.push("--session-id", request.sessionId);
  argv.push("--name", request.name);
  if (request.settingsPath) argv.push("--settings", request.settingsPath);
  // Strict: only the servers in the generated file, so none of the user's own and no claude.ai
  // connectors. The project's servers are written into that file.
  if (request.mcpConfigPath)
    argv.push("--strict-mcp-config", "--mcp-config", request.mcpConfigPath);
  if (request.systemPromptPath) argv.push("--append-system-prompt-file", request.systemPromptPath);
  if (session.permissionMode) argv.push("--permission-mode", session.permissionMode);
  for (const plugin of session.plugins) argv.push("--plugin-dir", plugin.path);
  if (request.skillPluginPath) argv.push("--plugin-dir", request.skillPluginPath);
  // After the profile's own arguments, so these win over a model set there.
  if (session.model) argv.push("--model", session.model);
  if (session.effort) argv.push("--effort", session.effort);
  if (request.task) argv.push(request.task);
  return { argv, env: { ...NO_TOOL_TIMEOUT_ENV, ...request.profile.env } };
}

/** The role's allow list, plus the Skill tool when the role lists skills, which need it. */
function allowedTools(session: ResolvedSession): string[] {
  const tools = session.tools ?? [];
  const needsSkill = (session.skills?.length ?? 0) > 0 && !tools.includes("Skill");
  return needsSkill ? [...tools, "Skill"] : tools;
}

/** Events after which a session may sit idle, so the mailbox hook is (re)armed on them. */
const MAILBOX_EVENTS: readonly string[] = ["SessionStart", "Stop"];

/**
 * Settings passed with `--settings`: hooks for state, the mailbox hook for incoming messages
 * (an `asyncRewake` hook, which wakes even an idle session; see docs/spikes.md, S3), a
 * statusline command for telemetry (it prints nothing, so the session shows no status line),
 * the role's permission rules with the dwa tools always allowed, and the two things the launch
 * flags cannot keep out: the user's personal instructions and project skills the role does not list.
 */
export function buildClaudeSettings(
  commands: SessionCommands,
  session: ResolvedSession,
  isolation: SessionIsolation,
) {
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
  const offSkills = [...new Set([...session.hiddenSkills, ...session.offSkills])];
  return {
    hooks,
    statusLine: { type: "command", command: commands.statusline },
    permissions: {
      allow: [`mcp__${APP_NAME}`, ...session.allow],
      ...(session.deny.length > 0 ? { deny: session.deny } : {}),
    },
    ...(isolation.personalMemory.length > 0 ? { claudeMdExcludes: isolation.personalMemory } : {}),
    ...(offSkills.length > 0
      ? { skillOverrides: Object.fromEntries(offSkills.map((name) => [name, "off"])) }
      : {}),
    ...(session.offPlugins.length > 0
      ? { enabledPlugins: Object.fromEntries(session.offPlugins.map((id) => [id, false])) }
      : {}),
    // The Claude command's own memory lives in the user's config, so it is theirs, not the
    // project's: a session has it only when its role asks for it.
    ...(session.memory ? {} : { autoMemoryEnabled: false }),
  };
}

/**
 * The only MCP servers the session gets (it is started with `--strict-mcp-config`): the ones
 * the project and the role's plugins define, the role's own from the catalogue, and dwa's. On a
 * name used twice the later of these wins, and nothing can take the place of dwa's.
 */
export function buildClaudeMcpConfig(
  server: McpServerCommand,
  session: ResolvedSession,
  projectServers: Record<string, unknown>,
) {
  const catalogue = Object.fromEntries(
    Object.entries(session.mcp).map(([name, entry]) => [
      name,
      "command" in entry ? { ...entry, type: "stdio" } : entry,
    ]),
  );
  return {
    mcpServers: { ...projectServers, ...catalogue, [APP_NAME]: { type: "stdio", ...server } },
  };
}

export const claudeProvider: Provider = {
  id: "claude",
  buildLaunch: buildClaudeLaunch,
  buildSettings: buildClaudeSettings,
  buildMcpConfig: buildClaudeMcpConfig,
  systemPrompt: sessionPrompt,
};
