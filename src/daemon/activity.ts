import type { AgentActivity, Telemetry } from "../shared/protocol.ts";
import { approvesOwnTool } from "../shared/tools.ts";

export interface ActivityChange {
  activity: AgentActivity;
  /** Short text for the agent tile: the tool in use, what is being asked, the last reply. */
  detail: string | null;
}

type Input = Record<string, unknown>;

const DETAIL_LENGTH = 120;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** First non-empty line, shortened, for a one-line summary. */
export function snippet(value: unknown, length = DETAIL_LENGTH): string | null {
  const line = text(value)
    ?.split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  if (!line) return null;
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

/**
 * Maps a Claude Code hook event to the agent's new activity, or null when the event does not
 * change it. The sequence was recorded from real sessions; see docs/spikes.md (S2).
 */
export function reduceHook(event: string, input: Input): ActivityChange | null {
  switch (event) {
    case "SessionStart":
      return { activity: "idle", detail: null };
    case "UserPromptSubmit":
      return { activity: "working", detail: null };
    case "PreToolUse":
      return { activity: "working", detail: text(input.tool_name) };
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionDenied":
    case "PostCompact":
      return { activity: "working", detail: null };
    case "PreCompact":
      return { activity: "working", detail: "compacting" };
    case "PermissionRequest":
      // The hook answers this one itself, so nobody is asked.
      if (approvesOwnTool(input)) return null;
      return { activity: "needs_user", detail: permissionDetail(input) };
    case "Notification":
      return reduceNotification(input);
    case "Stop":
      return { activity: "idle", detail: snippet(input.last_assistant_message) };
    case "StopFailure":
      return {
        activity: "error",
        detail: snippet(input.error) ?? snippet(input.message) ?? "the turn failed",
      };
    default:
      return null;
  }
}

function permissionDetail(input: Input): string {
  const tool = text(input.tool_name);
  return tool ? `permission: ${tool}` : "permission needed";
}

function reduceNotification(input: Input): ActivityChange | null {
  switch (input.notification_type) {
    case "permission_prompt":
      // PermissionRequest already set the state a few seconds earlier; keep its detail.
      return null;
    case "idle_prompt":
      return null;
    case "agent_needs_input":
    case "elicitation_dialog":
      return { activity: "needs_user", detail: snippet(input.message) ?? "input needed" };
    default:
      return null;
  }
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function limit(value: unknown): Telemetry["fiveHour"] {
  if (typeof value !== "object" || value === null) return null;
  const { used_percentage, resets_at } = value as Input;
  const usedPercent = number(used_percentage);
  if (usedPercent === null) return null;
  return { usedPercent, resetsAt: number(resets_at) };
}

/** Picks the fields dwa shows out of the statusline JSON Claude Code sends every few seconds. */
export function parseStatusline(data: unknown, now: number): Telemetry | null {
  if (typeof data !== "object" || data === null) return null;
  const input = data as Record<string, Input | undefined>;
  const model = input.model;
  return {
    contextPercent: number(input.context_window?.used_percentage),
    costUsd: number(input.cost?.total_cost_usd),
    model: typeof model === "object" ? (text(model.display_name) ?? text(model.id)) : text(model),
    fiveHour: limit(input.rate_limits?.five_hour),
    sevenDay: limit(input.rate_limits?.seven_day),
    updatedAt: now,
  };
}
