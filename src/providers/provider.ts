import type { ResolvedProfile } from "../shared/config.ts";

export interface LaunchRequest {
  profile: ResolvedProfile;
  /** Session id chosen by dwa so it can match hook events to the agent. */
  sessionId: string;
  /** Display name, also the address other sessions use to message this one. */
  name: string;
  /** Agent definition to run as (for Claude Code: a `.claude/agents/<role>.md` file). */
  role?: string;
  /** First prompt, given when the agent is spawned with a task. */
  task?: string;
  /** Path of the per-session settings file written from `buildSettings`. */
  settingsPath?: string;
  /** Path of the per-session MCP config written from `buildMcpConfig`. */
  mcpConfigPath?: string;
  /** Text appended to the session's system prompt. */
  systemPrompt?: string;
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

export interface McpServerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** One coding-agent CLI. Claude Code is the only implementation for now. */
export interface Provider {
  id: string;
  buildLaunch(request: LaunchRequest): Launch;
  /**
   * Contents of the per-session settings file that wires the session's lifecycle events and
   * telemetry to dwa. It is passed on the command line, so the user's own settings stay untouched.
   */
  buildSettings(commands: SessionCommands): unknown;
  /** Contents of the per-session MCP config that gives the session the dwa tools. */
  buildMcpConfig(server: McpServerCommand): unknown;
  /** Text appended to the system prompt, explaining the workspace and its tools. */
  systemPrompt(name: string): string;
}
