// Pure functions that turn workspace state into what the panes show. No terminal code here,
// so everything is unit-tested without a renderer.
import { MAX_VISIBLE_AGENTS } from "../shared/constants.ts";
import { contextText } from "../shared/context.ts";
import type {
  AgentActivity,
  AgentInfo,
  UsageLimit,
  WorkflowRunInfo,
  WorkflowRunState,
  WorkflowStepInfo,
  WorkspaceState,
} from "../shared/protocol.ts";
import { capabilityLines, type SessionSummary } from "../shared/roles.ts";

export type Tone = "good" | "muted" | "attention" | "bad";

export interface ActivityStyle {
  glyph: string;
  label: string;
  tone: Tone;
}

const ACTIVITY: Record<AgentActivity, ActivityStyle> = {
  starting: { glyph: "…", label: "starting", tone: "muted" },
  working: { glyph: "●", label: "working", tone: "good" },
  idle: { glyph: "○", label: "idle", tone: "muted" },
  needs_user: { glyph: "◆", label: "needs you", tone: "attention" },
  error: { glyph: "✖", label: "error", tone: "bad" },
};

export function activityStyle(activity: AgentActivity): ActivityStyle {
  return ACTIVITY[activity];
}

export interface Tile {
  id: string;
  /** 1-based position, the number used with the prefix key. */
  position: number;
  name: string;
  /** Role, when it differs from the name. */
  role: string | null;
  open: boolean;
  style: ActivityStyle;
  detail: string | null;
  /** What the session may use, as short lines; shown for the selected agent. */
  capabilities: string[];
  /** What is about to change for the session, or could: shown for the selected agent. */
  notices: string[];
}

/** What the user should know about a session that is not as its role says any more. */
export function agentNotices(agent: AgentInfo): string[] {
  if (agent.pendingRestart) return ["restarts at turn end"];
  if (agent.outOfDate) return ["role changed since start"];
  return [];
}

/**
 * Breaks a line into at most `lines` rows of `width` characters, at a space or comma where
 * there is one; what does not fit after that ends in an ellipsis.
 */
export function wrap(text: string, width: number, lines = 2): string[] {
  if (width <= 0) return [];
  const rows: string[] = [];
  let rest = text;
  while (rest.length > width && rows.length < lines - 1) {
    const at = rest.lastIndexOf(" ", width);
    const cut = at > width / 2 ? at : width;
    rows.push(rest.slice(0, cut).trimEnd());
    // Later rows are indented, so a continued line reads as one.
    rest = `  ${rest.slice(cut).trimStart()}`;
  }
  rows.push(fit(rest, width));
  return rows;
}

/**
 * Breaks every line of a text into rows of at most `width` characters, at a space where there is
 * one. Nothing is left out, and a continued line keeps the indent it started with.
 */
export function wrapAll(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const line of text.split("\n")) {
    const indent = /^ */.exec(line)?.[0] ?? "";
    // An indent that leaves no room for words is dropped rather than kept.
    const lead = indent.length < width / 2 ? indent : "";
    const room = Math.max(1, width - lead.length);
    let rest = line.slice(indent.length);
    while (rest.length > room) {
      const at = rest.lastIndexOf(" ", room);
      const cut = at > room / 2 ? at : room;
      rows.push(lead + rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    rows.push(lead + rest);
  }
  return rows;
}

/**
 * What a session was started with, in a few short lines: always the tools, and the MCP servers,
 * plugins and skills only when there is something to say. Empty when it was not recorded.
 */
export function capabilityNote(summary: SessionSummary | null): string[] {
  if (!summary) return [];
  const lines = new Map(capabilityLines(summary));
  const note = [`tools ${lines.get("tools")}`];
  if (summary.mcp.length > 0) note.push(`mcp ${lines.get("mcp")}`);
  if (summary.plugins.length > 0) note.push(`plugins ${lines.get("plugins")}`);
  if (summary.skills) note.push(`skills ${lines.get("skills")}`);
  return note;
}

/**
 * How an agent is shown. An agent blocked on a question it asked is "waiting", which matters
 * more than the tool call that carries the question; when it waits on the user it needs them.
 */
export function agentStyle(agent: AgentInfo): ActivityStyle {
  if (agent.waitingOn === "user") return { glyph: "◆", label: "asks you", tone: "attention" };
  if (agent.waitingOn) {
    return { glyph: "◷", label: `waiting on ${agent.waitingOn}`, tone: "muted" };
  }
  return activityStyle(agent.activity);
}

/** The one-line note under an agent: its own progress report while it works, else the detail. */
export function agentNote(agent: AgentInfo): string | null {
  if (agent.waitingOn) return null;
  if (agent.activity === "working" && agent.progress) return agent.progress;
  return agent.detail;
}

export function tiles(state: WorkspaceState): Tile[] {
  return state.agents.map((agent, index) => ({
    id: agent.id,
    position: index + 1,
    name: agent.name,
    role: agent.role && agent.role !== agent.name ? agent.role : null,
    open: agent.open,
    style: agentStyle(agent),
    detail: agentNote(agent),
    capabilities: capabilityNote(agent.capabilities),
    notices: agentNotices(agent),
  }));
}

/** "AGENTS 3", or "AGENTS 4–15 of 20" when the list is longer than what fits. */
export function agentsHeader(
  total: number,
  firstVisible = 0,
  visible = MAX_VISIBLE_AGENTS,
): string {
  if (total <= visible) return `AGENTS ${total}`;
  const first = Math.min(firstVisible, total - visible) + 1;
  return `AGENTS ${first}–${first + visible - 1} of ${total}`;
}

/** Shortens text to `max` characters, ending in an ellipsis when something was cut. */
export function fit(text: string, max: number): string {
  if (max <= 0) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Moves a list cursor by `delta`, staying inside the list. */
export function moveCursor(current: number, delta: number, count: number): number {
  if (count === 0) return 0;
  return Math.max(0, Math.min(count - 1, current + delta));
}

/**
 * A thin meter in two parts, "━━━" and "─────", so the part in use can be coloured and the rest
 * dimmed. Anything above zero shows at least one cell.
 */
export function bar(percent: number, width: number): [used: string, rest: string] {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = clamped > 0 ? Math.max(1, Math.round((clamped / 100) * width)) : 0;
  return ["━".repeat(filled), "─".repeat(width - filled)];
}

/** Tone for a usage or context percentage. */
export function percentTone(percent: number): Tone {
  if (percent >= 90) return "bad";
  if (percent >= 70) return "attention";
  return "good";
}

/** "in 2h 5m", "in 3d 4h", "in 12m"; null when the time is unknown or already past. */
export function untilReset(resetsAt: number | null, nowMs: number): string | null {
  if (resetsAt === null) return null;
  const minutes = Math.round((resetsAt * 1000 - nowMs) / 60000);
  if (minutes <= 0) return null;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes % 60}m`;
  return `in ${minutes}m`;
}

/** "just now", "5 min ago", "2 h ago", "3 d ago". */
export function ago(thenMs: number, nowMs: number): string {
  const minutes = Math.floor((nowMs - thenMs) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} d ago`;
}

/** "C-q" becomes "Ctrl+Q", "M-a" becomes "Alt+A"; anything else is shown as written. */
export function formatKey(tmuxKey: string): string {
  const match = tmuxKey.match(/^([CMS])-(.+)$/);
  if (!match) return tmuxKey;
  const modifier = { C: "Ctrl", M: "Alt", S: "Shift" }[match[1] as "C" | "M" | "S"];
  const key = match[2] ?? "";
  return `${modifier}+${key.length === 1 ? key.toUpperCase() : key}`;
}

const STEP: Record<WorkflowStepInfo["state"], ActivityStyle> = {
  pending: { glyph: "○", label: "pending", tone: "muted" },
  running: { glyph: "●", label: "running", tone: "good" },
  done: { glyph: "✓", label: "done", tone: "good" },
  failed: { glyph: "✖", label: "failed", tone: "bad" },
  skipped: { glyph: "–", label: "skipped", tone: "muted" },
  rejected: { glyph: "◆", label: "needs you", tone: "attention" },
};

/** How a workflow step's state shows: a sign, a word and a colour. */
export function stepStyle(state: WorkflowStepInfo["state"]): ActivityStyle {
  return STEP[state];
}

const RUN_TONE: Record<WorkflowRunState, Tone> = {
  running: "good",
  done: "muted",
  failed: "bad",
  cancelled: "muted",
};

export interface WorkflowLine {
  id: number;
  /** "#3 feature". */
  heading: string;
  state: WorkflowRunState;
  tone: Tone;
  /** The steps of a run in progress; a finished run is shown as its heading only. */
  steps: { name: string; style: ActivityStyle }[];
}

export function workflowLine(run: WorkflowRunInfo): WorkflowLine {
  return {
    id: run.id,
    heading: `#${run.id} ${run.name}`,
    state: run.state,
    tone: RUN_TONE[run.state],
    steps:
      run.state === "running"
        ? run.steps.map((step) => ({
            name: step.id,
            style: step.needsAttention
              ? { glyph: "◆", label: "needs you", tone: "attention" }
              : STEP[step.state],
          }))
        : [],
  };
}

export interface Meter {
  label: string;
  /** Null when the value is not reported; shown as N/A, never guessed. */
  percent: number | null;
  /** The value in words, at the right of the title: "34%", "5%/1M". Null when not reported. */
  value: string | null;
  /** Shown dimmed after the label: when a limit resets. */
  note: string | null;
}

export interface StatusModel {
  /** The session the status, model and cost belong to: the open agent, otherwise main. */
  subject: AgentInfo | null;
  subjectStyle: ActivityStyle | null;
  model: string | null;
  cost: string | null;
  context: Meter;
  limits: Meter[];
  counts: { working: number; idle: number; needsYou: number; total: number };
  /** Agents (and main) waiting for the user, by name. */
  waiting: { name: string; detail: string | null }[];
  /** Open questions, oldest first. */
  questions: { id: number; forUser: boolean; heading: string; text: string }[];
  /** Latest messages to the user, newest first. */
  inbox: { from: string; age: string; text: string }[];
  /** Workflow runs, newest first. */
  workflows: WorkflowLine[];
}

function limitMeter(label: string, limit: UsageLimit | null | undefined, nowMs: number): Meter {
  return {
    label,
    percent: limit?.usedPercent ?? null,
    value: limit ? `${Math.round(limit.usedPercent)}%` : null,
    note: limit ? untilReset(limit.resetsAt, nowMs) : null,
  };
}

export function statusModel(state: WorkspaceState, nowMs: number): StatusModel {
  const everyone = [...(state.main ? [state.main] : []), ...state.agents];
  const subject = state.agents.find((agent) => agent.open) ?? state.main;
  const telemetry = subject?.telemetry ?? null;
  const main = state.main?.telemetry ?? null;
  // Usage limits belong to the account, so the freshest report from any session will do.
  const freshest = everyone
    .map((agent) => agent.telemetry)
    .filter((entry) => entry?.fiveHour || entry?.sevenDay)
    .sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0))[0];

  return {
    subject,
    subjectStyle: subject ? agentStyle(subject) : null,
    model: telemetry?.model ?? null,
    cost: telemetry?.costUsd == null ? null : `$${telemetry.costUsd.toFixed(2)}`,
    // Always the main session's: an agent's own is on the status line of its pane.
    context: {
      label: subject && subject !== state.main ? "main context" : "context",
      percent: main?.contextPercent ?? null,
      value: contextText(main?.contextPercent ?? null, main?.contextSize ?? null),
      note: null,
    },
    limits: [
      limitMeter("5 hours", freshest?.fiveHour, nowMs),
      limitMeter("7 days", freshest?.sevenDay, nowMs),
    ],
    counts: {
      working: state.agents.filter((agent) => agent.activity === "working").length,
      idle: state.agents.filter((agent) => agent.activity === "idle").length,
      needsYou: state.agents.filter((agent) => agent.activity === "needs_user").length,
      total: state.agents.length,
    },
    waiting: everyone
      .filter((agent) => agent.activity === "needs_user")
      .map((agent) => ({ name: agent.name, detail: agent.detail })),
    questions: state.questions.map((question) => ({
      id: question.id,
      forUser: question.to === "user",
      heading: `#${question.id} ${question.from} → ${question.to === "user" ? "you" : question.to}`,
      text: question.question,
    })),
    inbox: state.inbox.map((message) => ({
      from: message.from,
      age: ago(message.createdAt, nowMs),
      text: message.body,
    })),
    workflows: state.workflows.map(workflowLine),
  };
}
