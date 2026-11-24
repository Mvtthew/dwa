/** Types shared by the daemon, the CLI and the UI panes. */

export type AgentKind = "main" | "agent";

/**
 * M1 knows only whether a session's pane is alive. Hook-driven states
 * (working, idle, needs user, waiting on someone) are added in M2.
 */
export type AgentState = "running" | "stopped";

/**
 * What a running session is doing, taken from its hook events:
 * starting (no event yet), working, idle (turn finished, ready for input),
 * needs_user (a permission prompt or dialog is waiting), error (the turn failed).
 */
export type AgentActivity = "starting" | "working" | "idle" | "needs_user" | "error";

export interface UsageLimit {
  usedPercent: number;
  /** Unix seconds, when known. */
  resetsAt: number | null;
}

/** Figures Claude Code reports through the statusline; null when not reported. */
export interface Telemetry {
  contextPercent: number | null;
  costUsd: number | null;
  model: string | null;
  fiveHour: UsageLimit | null;
  sevenDay: UsageLimit | null;
  updatedAt: number;
}

export interface AgentInfo {
  id: string;
  kind: AgentKind;
  name: string;
  role: string | null;
  profile: string;
  sessionId: string;
  paneId: string;
  state: AgentState;
  task: string | null;
  createdAt: number;
  activity: AgentActivity;
  /** One line about the activity: tool in use, permission asked for, last reply. */
  detail: string | null;
  /** When the activity last changed (ms). */
  activitySince: number;
  telemetry: Telemetry | null;
  /** True when this agent's session is the pane shown under the main session. */
  open: boolean;
}

export interface WorkspaceState {
  projectRoot: string;
  up: boolean;
  main: AgentInfo | null;
  /** Running agents only, oldest first. */
  agents: AgentInfo[];
}

export interface SpawnRequest {
  name?: string;
  role?: string;
  profile?: string;
  task?: string;
}

export interface HookRequest {
  agentId: string;
  event: string;
  input: unknown;
}

export interface StatuslineRequest {
  agentId: string;
  data: unknown;
}

export interface UpRequest {
  profile?: string;
}

export interface ErrorResponse {
  error: string;
}
