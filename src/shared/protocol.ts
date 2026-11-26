/** Types shared by the daemon, the CLI and the UI panes. */

import type { Capabilities } from "./capabilities.ts";
import type { FileTarget } from "./role-edit.ts";
import type { SessionSummary } from "./roles.ts";
import type { ToolChange, ToolView } from "./tools.ts";

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
  /** The size of the context window in tokens. */
  contextSize: number | null;
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
  /**
   * The session owes a result to the one that started it and is still being reminded to
   * report it, so an idle moment is not yet its last word.
   */
  reportDue?: boolean;
  /** The name of the session that started this one with `spawn_agent`, when one did. */
  startedBy?: string;
  /** True when this agent's session is the pane shown under the main session. */
  open: boolean;
  /** What the session was started with; null for one started before this was recorded. */
  capabilities: SessionSummary | null;
  /** The role files or the config changed since the session was started. */
  outOfDate?: boolean;
  /** The session restarts with new settings when its turn ends. */
  pendingRestart?: boolean;
}

/** A running session as the tools dialog names it. */
export interface SessionRef {
  id: string;
  name: string;
  role: string | null;
  kind: AgentKind;
  activity: AgentActivity;
}

/** What the tools dialog shows for one session. */
export interface ToolsInfo {
  agent: SessionRef;
  view: ToolView;
  /** Files a change can be saved in for good: the role, its parents, `[defaults]`. */
  files: { label: string; file: FileTarget }[];
  /** The role files or the config changed since this session was started. */
  outOfDate: boolean;
}

/** `now` interrupts a working session; `turn-end` waits until it has finished its turn. */
export type RestartWhen = "now" | "turn-end";

export interface ToolsSaveRequest {
  /** Session name or id. */
  target: string;
  changes: ToolChange[];
  /**
   * `agent`: this session only. `run`: also every session of its role started later, until the
   * workspace stops. `file`: written into `file`; running sessions are then refreshed separately.
   */
  scope: "agent" | "run" | "file";
  file?: FileTarget;
  /** Needed when the change takes a restart and the session is working, or is the main one. */
  when?: RestartWhen;
}

/**
 * How a change reached a session: `live` without a restart, `restarted`, `pending` (it restarts
 * when its turn ends), `unchanged` (nothing differed), or `ask` when nothing was done because
 * the caller has to say `when` first.
 */
export type Applied = "live" | "restarted" | "pending" | "unchanged" | "ask";

export interface ToolsSaveResult {
  applied: Applied;
  /** For `ask`: why a restart needs a decision. */
  reason?: "working" | "main";
  /** For a save into a file: the version it is at now. */
  version?: number;
  /** Something the user should know, such as a role that sets the value itself. */
  note?: string;
  /** Running sessions that are now behind the files, the changed one included. */
  behind: SessionRef[];
}

export interface RefreshRequest {
  targets: string[];
  when?: RestartWhen;
}

/** Whether the main session leads, and where that is decided. */
export interface LeaderInfo {
  on: boolean;
  /** The project's config sets it, so the switch (which writes the personal config) cannot. */
  project: boolean;
}

export interface LeaderRequest {
  on: boolean;
  /** How to restart the main session; without it the answer is `ask`. */
  when?: RestartWhen;
}

export interface LeaderResult extends LeaderInfo {
  applied: Applied;
  /** For `ask`: why a restart needs a decision. */
  reason?: "working" | "main";
}

export interface RefreshResult {
  results: { name: string; applied: Applied; error?: string }[];
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

/** A run with the text of its own copy of the definition, for the designer. */
export interface WorkflowRunView {
  run: WorkflowRunInfo;
  /** The run's definition as TOML, without comments. */
  text: string;
  /** Names `text`; an edit that gives it as its base is refused when the run changed since. */
  revision: string;
  /** False when the run is over or ending: it can be looked at only. */
  editable: boolean;
}

/** What an edit of a running workflow does (or, as a preview, would do). */
export interface WorkflowEdit {
  run: WorkflowRunInfo;
  /** One line per change, empty when the definition is the same. */
  changes: string[];
  /** True when work already started is thrown away: a step runs again or a started step is removed. */
  restarts: boolean;
  applied: boolean;
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
  /** The plain shell pane: null until it is first shown, then whether it is under main now. */
  shell: { open: boolean } | null;
  /** The event feed: null when its pane is gone, else whether it is shown. */
  feed: { open: boolean } | null;
}

/** What an item of the event feed is about. */
export type FeedKind =
  | "recap"
  | "spawn"
  | "finish"
  | "message"
  | "question"
  | "answer"
  | "step"
  | "lifecycle";

export const FEED_KINDS: readonly FeedKind[] = [
  "recap",
  "spawn",
  "finish",
  "message",
  "question",
  "answer",
  "step",
  "lifecycle",
];

/** One thing that happened, as the feed pane lists it. */
export interface FeedItem {
  id: number;
  at: number;
  kind: FeedKind;
  /** The session it is about or that did it; null for the user or a workflow. */
  agentId: string | null;
  /** That session's name at the time, or "user" or "workflow". */
  agent: string | null;
  /** True when it is about the main session. */
  main: boolean;
  /** The other side: who a message went to, who was started, who answered. */
  refId: string | null;
  ref: string | null;
  /** One line. */
  title: string;
  /** The text, cut short in a list (`GET /feed`) and whole for one item (`GET /feed/item`). */
  body: string;
  /** Details by kind: for a spawn its role, profile, effort, skill, who started it. */
  data: Record<string, unknown> | null;
}

/** One feed item with everything the reader popup shows. */
export interface FeedDetail extends FeedItem {
  /** For a spawn: what the session was started with, as label and text. */
  launch: [label: string, text: string][] | null;
}

/** The wizards that open in a popup over the workspace. */
export type WizardKind =
  | "workflows"
  | "agent"
  | "tools"
  | "roles"
  | "design"
  | "messages"
  | "feed"
  | "leader";

/** Everything the daemon can show in a popup: the wizards, the question queue, the command menu. */
export type PopupKind = WizardKind | "questions" | "palette";

export const POPUP_KINDS: readonly PopupKind[] = [
  "workflows",
  "agent",
  "tools",
  "roles",
  "design",
  "messages",
  "feed",
  "leader",
  "questions",
  "palette",
];

/**
 * The capability fields (tools, MCP servers, plugins, skills, ...) replace what the role says
 * for this one session.
 */
export interface SpawnRequest extends Omit<Capabilities, "effort"> {
  name?: string;
  /** A role file in `.dwa/roles/`. Without one the session gets the configured defaults. */
  role?: string;
  profile?: string;
  /** Passed as `--effort`: low, medium, high, xhigh or max. */
  effort?: string;
  task?: string;
  /**
   * A skill to run as this session's task, by name (`skillTask`): what a skill that asks for a
   * subagent of its own becomes in the workspace. `task` is then what the skill is given.
   */
  skill?: string;
  /**
   * Set for a spawn an agent asks for: the capability fields may then only take away from the
   * role, never add to it.
   */
  narrowOnly?: boolean;
  /**
   * The id of the session that asks (`spawn_agent`). The new session then owes it a result
   * and ends once it has reported one with `finish_task`. Absent for the user's own spawns,
   * the agents of the config and workflow steps.
   */
  from?: string;
  /** With `from`: the session stays open after it has reported its result. */
  keep?: boolean;
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
