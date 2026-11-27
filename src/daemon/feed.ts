import type { FeedClearScope, FeedDetail, FeedItem, FeedKind } from "../shared/protocol.ts";
import { capabilityLines, type ResolvedSession, summarizeSession } from "../shared/roles.ts";
import { snippet } from "./activity.ts";
import { type FeedRow, MAX_FEED, type Store } from "./db.ts";

/** Characters of a body kept in the store: a reply or a result longer than this is cut. */
export const MAX_FEED_BODY = 20000;
/** Characters of a body a list of items carries; the reader popup asks for the rest. */
export const FEED_PREVIEW = 400;

/** The id up to which items are no longer listed. Clearing moves it; no row is deleted. */
export const META_FEED_CLEARED = "feed_cleared";

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
 *
 * A `session` item is a separator: it stands where a main session starts or starts over. Clearing
 * hides, it never deletes: `cleared` is the id up to which items are not listed any more, and a
 * hidden item can still be read by its id.
 */
export class Feed {
  constructor(
    private readonly store: Store,
    private readonly now: () => number,
  ) {}

  /** The id of the new item, or null when it could not be written. */
  add(entry: FeedEntry): number | null {
    try {
      const body = (entry.body ?? "").slice(0, MAX_FEED_BODY);
      const title = entry.title ?? snippet(body) ?? entry.kind;
      return this.store.addFeed({
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
      return null;
    }
  }

  /** The id up to which items are hidden; 0 when nothing was cleared. */
  cleared(): number {
    return Number(this.store.getMeta(META_FEED_CLEARED)) || 0;
  }

  /**
   * Takes items out of what is listed: all of them, or the ones above the latest separator.
   * Returns the point reached, which only ever moves forward.
   */
  clear(scope: FeedClearScope): number {
    const target = scope === "all" ? this.store.lastFeedId() : this.store.lastFeedId("session") - 1;
    return this.clearTo(target);
  }

  /** The separator of a new workspace: what came before it is hidden. */
  startSession(entry: Omit<FeedEntry, "kind">): void {
    const id = this.add({ ...entry, kind: "session" });
    try {
      if (id !== null) this.clearTo(id - 1);
    } catch (error) {
      console.error("could not clear the feed:", error);
    }
  }

  private clearTo(id: number): number {
    const before = this.cleared();
    if (id <= before) return before;
    this.store.setMeta(META_FEED_CLEARED, String(id));
    return id;
  }

  /** Items after `after`, oldest first; without it the latest ones. Cleared items are left out. */
  list(after = 0, limit = 200): FeedItem[] {
    const count = Math.max(1, Math.min(MAX_FEED, Math.floor(limit)));
    return this.store
      .feedAfter(Math.max(0, after), count, FEED_PREVIEW, this.cleared())
      .map(toItem);
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
