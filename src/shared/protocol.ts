/** Types shared by the daemon, the CLI and the UI panes. */

export type AgentKind = "main" | "agent";

/**
 * M1 knows only whether a session's pane is alive. Hook-driven states
 * (working, idle, needs user, waiting on someone) are added in M2.
 */
export type AgentState = "running" | "stopped";

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

export interface UpRequest {
  profile?: string;
}

export interface ErrorResponse {
  error: string;
}
