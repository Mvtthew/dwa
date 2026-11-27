// Pure view logic of the event feed pane: which items are shown and as what lines.
import type { FeedItem, FeedKind, WorkspaceState } from "../shared/protocol.ts";
import { ago, fit, type Tone, wrap } from "./model.ts";

/** What a switch in the feed's header shows or hides. Main's recaps have a switch of their own. */
export type FeedFilter = "recap" | "main" | "spawn" | "finish" | "message" | "step" | "lifecycle";

export const FEED_FILTERS: readonly { filter: FeedFilter; label: string }[] = [
  { filter: "recap", label: "Recaps" },
  { filter: "main", label: "Main" },
  { filter: "spawn", label: "Spawns" },
  { filter: "finish", label: "Results" },
  { filter: "message", label: "Talk" },
  { filter: "step", label: "Flows" },
  { filter: "lifecycle", label: "Life" },
];

/** Everything but the main session's own recaps, which come with every turn of the user's. */
export function defaultFilters(): Set<FeedFilter> {
  return new Set(FEED_FILTERS.map((entry) => entry.filter).filter((filter) => filter !== "main"));
}

/** The switch an item belongs to; a separator has none and is always shown. */
export function filterOf(item: FeedItem): FeedFilter | null {
  if (item.kind === "session") return null;
  if (item.kind === "recap") return item.main ? "main" : "recap";
  if (item.kind === "question" || item.kind === "answer") return "message";
  return item.kind;
}

/**
 * The session "only selected" keeps to: the agent shown under main, or else main itself. The
 * same one the status pane is about.
 */
export function feedSubject(state: WorkspaceState | null): { id: string; name: string } | null {
  const subject = state?.agents.find((agent) => agent.open) ?? state?.main ?? null;
  return subject ? { id: subject.id, name: subject.name } : null;
}

export interface FeedView {
  filters: ReadonlySet<FeedFilter>;
  /** The id of the session to keep to, or null for all. */
  only: string | null;
}

export function visibleItems(items: readonly FeedItem[], view: FeedView): FeedItem[] {
  return items.filter((item) => {
    const filter = filterOf(item);
    // A separator stays whatever is switched off: it says where a session begins.
    if (filter === null) return true;
    if (!view.filters.has(filter)) return false;
    if (view.only === null) return true;
    return item.agentId === view.only || item.refId === view.only;
  });
}

const GLYPHS: Record<FeedKind, string> = {
  recap: "✎",
  spawn: "+",
  finish: "✓",
  message: "✉",
  question: "?",
  answer: "↩",
  step: "▸",
  lifecycle: "·",
  session: "─",
};

export function itemTone(item: FeedItem): Tone | undefined {
  if (item.kind === "finish") return "good";
  if (item.kind === "question") return "attention";
  if (item.kind === "step" && item.data?.state === "failed") return "bad";
  if (item.kind === "step" && item.data?.state === "done") return "good";
  return undefined;
}

export interface FeedLine {
  text: string;
  kind: "head" | "body";
}

/** Lines of text shown under an item's head in the list; the reader popup has the rest. */
const PREVIEW_LINES = 3;

/** The text under an item's head: what says most about it in a few lines. */
function preview(item: FeedItem): string {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  switch (item.kind) {
    // The reply itself; its first line is the title.
    case "recap":
      return flat(item.body);
    // Who started whom, then the task.
    case "spawn":
      return flat(`${item.title}: ${item.body}`);
    // The title has the first line of the result; the rest follows it.
    case "finish": {
      const [, ...rest] = item.body.split("\n");
      return flat([item.title, ...rest].join(" "));
    }
    default:
      return flat(item.title);
  }
}

/** An item as lines: a head with its glyph, who and when, then a few lines of text. */
export function itemLines(item: FeedItem, width: number, nowMs: number): FeedLine[] {
  const room = Math.max(8, width);
  if (item.kind === "session") {
    // A rule across the pane with what began and when in it.
    const label = `── ${item.title} · ${ago(item.at, nowMs)} `;
    const text = label.length < room ? label.padEnd(room, "─") : fit(label.trimEnd(), room);
    return [{ text, kind: "head" }];
  }
  const head = `${GLYPHS[item.kind]} ${item.agent ?? "dwa"}`;
  const when = ago(item.at, nowMs);
  const gap = room - head.length - when.length;
  return [
    { text: gap >= 1 ? `${head}${" ".repeat(gap)}${when}` : fit(head, room), kind: "head" },
    ...wrap(preview(item), room - 2, PREVIEW_LINES).map(
      (row): FeedLine => ({ text: `  ${row}`, kind: "body" }),
    ),
  ];
}
