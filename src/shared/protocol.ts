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
  /** Latest progress note the agent reported itself. */
  progress: string | null;
  /** Who this agent is blocked on through a question it asked ("user" or an agent name). */
  waitingOn: string | null;
  /** True when this agent's session is the pane shown under the main session. */
  open: boolean;
}

/** An open question. `from` and `to` are names ("user" or an agent name). */
export interface QuestionInfo {
  id: number;
  from: string;
  to: string;
  fromId: string;
  toId: string;
  question: string;
  options: string[];
  createdAt: number;
}

export interface MessageInfo {
  id: number;
  from: string;
  body: string;
  createdAt: number;
}

export type WorkflowRunState = "running" | "done" | "failed" | "cancelled";

/**
 * pending (waiting for its dependencies), running (an agent is working on it), done, failed,
 * skipped (never started because the run failed or was cancelled), rejected (a review step that
 * asked for changes once too often and waits for the user's decision).
 */
export type WorkflowStepState = "pending" | "running" | "done" | "failed" | "skipped" | "rejected";

export interface WorkflowStepInfo {
  id: string;
  state: WorkflowStepState;
  /** 1 on the first pass; higher when a review sent the work back. */
  attempt: number;
  dependsOn: string[];
  /** Name of the agent that runs or ran the step. */
  agent: string | null;
  result: string | null;
  error: string | null;
  /** True when the agent keeps ending its turn without completing the step, or a review waits for the user's decision. */
  needsAttention: boolean;
}

export interface WorkflowRunInfo {
  id: number;
  name: string;
  input: string;
  state: WorkflowRunState;
  /** "user" or an agent name. */
  startedBy: string;
  createdAt: number;
  finishedAt: number | null;
  /** In the order of the definition. */
  steps: WorkflowStepInfo[];
}

export interface WorkspaceState {
  projectRoot: string;
  /** The key pressed before a dwa shortcut, in tmux notation (e.g. "C-q"). */
  keyPrefix: string;
  up: boolean;
  main: AgentInfo | null;
  /** Running agents only, oldest first. */
  agents: AgentInfo[];
  /** Questions waiting for an answer, oldest first. */
  questions: QuestionInfo[];
  /** Latest messages sent to the user, newest first. */
  inbox: MessageInfo[];
  /** Workflow runs in progress and the latest finished ones, newest first. */
  workflows: WorkflowRunInfo[];
}

export interface SpawnRequest {
  name?: string;
  role?: string;
  profile?: string;
  /** Passed as `--model`. Without it the role file decides, then the configured default. */
  model?: string;
  /** Passed as `--effort`: low, medium, high, xhigh or max. */
  effort?: string;
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
