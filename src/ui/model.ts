// Pure functions that turn workspace state into what the panes show. No terminal code here,
// so everything is unit-tested without a renderer.
import { MAX_VISIBLE_AGENTS } from "../shared/constants.ts";
import type { AgentActivity, AgentInfo, UsageLimit, WorkspaceState } from "../shared/protocol.ts";

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
}

export function tiles(state: WorkspaceState): Tile[] {
  return state.agents.map((agent, index) => ({
    id: agent.id,
    position: index + 1,
    name: agent.name,
    role: agent.role && agent.role !== agent.name ? agent.role : null,
    open: agent.open,
    style: activityStyle(agent.activity),
    detail: agent.detail,
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

/** A text meter such as "█████░░░░░". */
export function bar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
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

/** "C-q" becomes "Ctrl+Q", "M-a" becomes "Alt+A"; anything else is shown as written. */
export function formatKey(tmuxKey: string): string {
  const match = tmuxKey.match(/^([CMS])-(.+)$/);
  if (!match) return tmuxKey;
  const modifier = { C: "Ctrl", M: "Alt", S: "Shift" }[match[1] as "C" | "M" | "S"];
  const key = match[2] ?? "";
  return `${modifier}+${key.length === 1 ? key.toUpperCase() : key}`;
}

export interface Meter {
  label: string;
  /** Null when the value is not reported; shown as N/A, never guessed. */
  percent: number | null;
  note: string | null;
}

export interface StatusModel {
  /** The session the figures belong to: the open agent, otherwise main. */
  subject: AgentInfo | null;
  subjectStyle: ActivityStyle | null;
  model: string | null;
  cost: string | null;
  context: Meter;
  limits: Meter[];
  counts: { working: number; idle: number; needsYou: number; total: number };
  /** Agents (and main) waiting for the user, by name. */
  waiting: { name: string; detail: string | null }[];
}

function limitMeter(label: string, limit: UsageLimit | null | undefined, nowMs: number): Meter {
  return {
    label,
    percent: limit?.usedPercent ?? null,
    note: limit ? untilReset(limit.resetsAt, nowMs) : null,
  };
}

export function statusModel(state: WorkspaceState, nowMs: number): StatusModel {
  const everyone = [...(state.main ? [state.main] : []), ...state.agents];
  const subject = state.agents.find((agent) => agent.open) ?? state.main;
  const telemetry = subject?.telemetry ?? null;
  // Usage limits belong to the account, so the freshest report from any session will do.
  const freshest = everyone
    .map((agent) => agent.telemetry)
    .filter((entry) => entry?.fiveHour || entry?.sevenDay)
    .sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0))[0];

  return {
    subject,
    subjectStyle: subject ? activityStyle(subject.activity) : null,
    model: telemetry?.model ?? null,
    cost: telemetry?.costUsd == null ? null : `$${telemetry.costUsd.toFixed(2)}`,
    context: { label: "context", percent: telemetry?.contextPercent ?? null, note: null },
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
  };
}
