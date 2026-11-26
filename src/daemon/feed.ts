import type { FeedDetail, FeedItem, FeedKind } from "../shared/protocol.ts";
import { capabilityLines, type ResolvedSession, summarizeSession } from "../shared/roles.ts";
import { snippet } from "./activity.ts";
import { type FeedRow, MAX_FEED, type Store } from "./db.ts";

/** Characters of a body kept in the store: a reply or a result longer than this is cut. */
export const MAX_FEED_BODY = 20000;
/** Characters of a body a list of items carries; the reader popup asks for the rest. */
export const FEED_PREVIEW = 400;

export interface FeedEntry {
  kind: FeedKind;
  agentId?: string | null;
  agentName?: string | null;
  refId?: string | null;
  refName?: string | null;
  /** One line; the first line of the body when not given. */
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}

function parse(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toItem(row: FeedRow): FeedItem {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind as FeedKind,
    agentId: row.agentId,
    agent: row.agentName,
    main: row.fromMain === 1,
    refId: row.refId,
    ref: row.refName,
    title: row.title,
    body: row.body,
    data: parse(row.data),
  };
}

/**
 * The event feed: what happened across the sessions, newest last. Writes are one SQLite insert,
 * so they are safe anywhere, also in `onAgentEvent` listeners and inside the tmux queue. A write
 * never throws: the feed is a record, and what it records must not fail because of it.
 */
export class Feed {
  constructor(
    private readonly store: Store,
    private readonly now: () => number,
  ) {}

  add(entry: FeedEntry): void {
    try {
      const body = (entry.body ?? "").slice(0, MAX_FEED_BODY);
      const title = entry.title ?? snippet(body) ?? entry.kind;
      this.store.addFeed({
        at: this.now(),
        kind: entry.kind,
        agentId: entry.agentId ?? null,
        agentName: entry.agentName ?? null,
        refId: entry.refId ?? null,
        refName: entry.refName ?? null,
        title: snippet(title) ?? entry.kind,
        body,
        data: entry.data ? JSON.stringify(entry.data) : null,
      });
    } catch (error) {
      console.error("could not record a feed item:", error);
    }
  }

  /** Items after `after`, oldest first; without it the latest ones. */
  list(after = 0, limit = 200): FeedItem[] {
    const count = Math.max(1, Math.min(MAX_FEED, Math.floor(limit)));
    return this.store.feedAfter(Math.max(0, after), count, FEED_PREVIEW).map(toItem);
  }

  /** One item whole, with what a started session was given. */
  item(id: number): FeedDetail | null {
    const row = this.store.feedItem(id);
    if (!row) return null;
    const item = toItem(row);
    let launch: FeedDetail["launch"] = null;
    if (item.kind === "spawn" && item.refId) {
      const stored = this.store.getLaunch(item.refId);
      try {
        if (stored) {
          launch = capabilityLines(summarizeSession(JSON.parse(stored) as ResolvedSession));
        }
      } catch {
        // A launch stored by an older version may not read; the item is shown without it.
      }
    }
    return { ...item, launch };
  }
}
