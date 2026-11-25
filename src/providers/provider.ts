import type { ResolvedProfile } from "../shared/config.ts";
import type { ResolvedSession } from "../shared/roles.ts";

export interface LaunchRequest {
  profile: ResolvedProfile;
  /** Session id chosen by dwa so it can match hook events to the agent. */
  sessionId: string;
  /** Continue the conversation of `sessionId` instead of starting a new one (a restart). */
  resume?: boolean;
  /** Display name, also the address other sessions use to message this one. */
  name: string;
  /** What the session may use and how it is tuned, after all layers of configuration. */
  session: ResolvedSession;
  /** First prompt, given when the agent is spawned with a task. */
  task?: string;
  /** Path of the per-session settings file written from `buildSettings`. */
  settingsPath?: string;
  /** Path of the per-session MCP config written from `buildMcpConfig`. */
  mcpConfigPath?: string;
  /** Path of the file written from `systemPrompt`, appended to the session's system prompt. */
  systemPromptPath?: string;
  /** Directory of the plugin generated for this session to carry its dwa skills, if any. */
  skillPluginPath?: string;
}

export interface Launch {
  argv: string[];
  env: Record<string, string>;
}

export interface SessionCommands {
  /** Shell command that reports a lifecycle event; the event name is appended as an argument. */
  hook: string;
  /** Shell command that receives the statusline JSON and prints the status line. */
  statusline: string;
  /** Shell command that waits for messages and wakes the session when one arrives. */
  mailbox: string;
}

/** What has to be named to keep the user's own Claude setup out of a session. */
export interface SessionIsolation {
  /** Personal instruction files (`CLAUDE.md` of the user's Claude config) not to load. */
  personalMemory: string[];
}

export interface McpServerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** One coding-agent CLI. Claude Code is the only implementation for now. */
/** Parts of the system prompt that are worked out when the session's files are written. */
export interface PromptExtras {
  /** The list of roles (`roleGuidePrompt`); empty or absent when the session gets none. */
  roleGuide?: string;
}

export interface Provider {
  id: string;
  buildLaunch(request: LaunchRequest): Launch;
  /**
   * Contents of the per-session settings file that wires the session's lifecycle events and
   * telemetry to dwa. It is passed on the command line, so the user's own settings stay untouched.
   */
  buildSettings(
    commands: SessionCommands,
    session: ResolvedSession,
    isolation: SessionIsolation,
  ): unknown;
  /**
   * Contents of the per-session MCP config: the dwa tools and the servers the session's role
   * lists. `projectServers` are the ones the project itself defines, which every session keeps.
   */
  buildMcpConfig(
    server: McpServerCommand,
    session: ResolvedSession,
    projectServers: Record<string, unknown>,
  ): unknown;
  /**
   * Text appended to the system prompt: the workspace and its tools, then the role's own
   * instructions, then the roles the session can hand work to when it is given that list.
   */
  systemPrompt(name: string, session: ResolvedSession, extras?: PromptExtras): string;
}
