import {
  BoxRenderable,
  bold,
  type CliRenderer,
  dim,
  reverse,
  ScrollBoxRenderable,
  type TextRenderable,
} from "@opentui/core";
import type { FeedItem, WorkspaceState } from "../shared/protocol.ts";
import {
  defaultFilters,
  FEED_FILTERS,
  type FeedFilter,
  feedSubject,
  itemLines,
  itemTone,
  visibleItems,
} from "./feed-model.ts";
import { createText, type Part, styled } from "./text.ts";
import { tone } from "./theme.ts";

/** Items the pane keeps; older ones are dropped from it (the store keeps more). */
const KEPT_ITEMS = 500;

export interface FeedActions {
  /** Open the reader popup for one item. */
  open(itemId: number): void;
}

export interface FeedPaneView {
  update(state: WorkspaceState, nowMs: number): void;
  /** New items, oldest first. */
  add(items: FeedItem[]): void;
  showMessage(message: string): void;
}

/** A switch in the header: a type of item, or "only the selected session". */
type Switch = { filter: FeedFilter } | { only: true };

interface Placed {
  row: number;
  x: number;
  text: string;
  on: boolean;
  target: Switch;
}

/** Lays the switches out in rows as wide as the pane, each as " Label ". */
function placeSwitches(
  filters: ReadonlySet<FeedFilter>,
  only: boolean,
  subject: string | null,
  width: number,
): Placed[] {
  const entries: Omit<Placed, "row" | "x">[] = [
    ...FEED_FILTERS.map((entry) => ({
      text: ` ${entry.label} `,
      on: filters.has(entry.filter),
      target: { filter: entry.filter } as Switch,
    })),
    { text: ` Only ${subject ?? "selected"} `, on: only, target: { only: true } },
  ];
  const placed: Placed[] = [];
  let row = 0;
  let x = 0;
  for (const entry of entries) {
    if (x > 0 && x + entry.text.length > width) {
      row++;
      x = 0;
    }
    placed.push({ ...entry, row, x });
    x += entry.text.length + 1;
  }
  return placed;
}

/**
 * The event feed, a column right of the agents pane: recaps, spawns, results, messages, workflow
 * steps and lifecycle events, newest at the bottom. It follows new items unless scrolled up.
 * The switches at the top choose the types shown (main's recaps are off at first) and whether
 * only the selected session's items are; a click on an item opens it whole in a popup.
 */
export function createFeedView(renderer: CliRenderer, actions: FeedActions): FeedPaneView {
  const root = new BoxRenderable(renderer, {
    id: "feed-root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    paddingX: 1,
  });
  const header = createText(renderer, "feed-header", 2, false);
  const list = new ScrollBoxRenderable(renderer, {
    id: "feed-list",
    flexGrow: 1,
    flexShrink: 1,
    stickyScroll: true,
    stickyStart: "bottom",
    verticalScrollbarOptions: { visible: false },
    horizontalScrollbarOptions: { visible: false },
  });
  const empty = createText(renderer, "feed-empty", 1);
  root.add(header);
  root.add(list);
  root.add(empty);
  renderer.root.add(root);

  const filters = defaultFilters();
  let only = false;
  let state: WorkspaceState | null = null;
  let now = Date.now();
  let items: FeedItem[] = [];
  let switches: Placed[] = [];
  let nodes: { item: FeedItem; box: BoxRenderable; text: TextRenderable }[] = [];
  /** The width and switches the list was built for; a change rebuilds it. */
  let builtFor = "";

  const width = () => Math.max(10, renderer.width - 2);
  const view = () => ({
    filters,
    only: only ? (feedSubject(state)?.id ?? null) : null,
  });

  const paintHeader = () => {
    switches = placeSwitches(filters, only, feedSubject(state)?.name ?? null, width());
    const rows: Part[][] = [];
    for (const entry of switches) {
      const line = rows[entry.row] ?? [];
      rows[entry.row] = line;
      if (line.length > 0) line.push(" ");
      // On is inverse video, off is dim: never told apart by colour alone.
      line.push(entry.on ? reverse(bold(entry.text)) : dim(entry.text));
    }
    header.height = rows.length + 1;
    header.content = styled([...rows, []]);
  };
  header.onMouseDown = (event) => {
    const row = event.y - header.screenY;
    const x = event.x - header.screenX;
    const hit = switches.find(
      (entry) => entry.row === row && x >= entry.x && x < entry.x + entry.text.length,
    );
    if (!hit) return;
    if ("only" in hit.target) only = !only;
    else if (filters.has(hit.target.filter)) filters.delete(hit.target.filter);
    else filters.add(hit.target.filter);
    paint();
  };

  const paintItem = (node: (typeof nodes)[number]) => {
    const lines = itemLines(node.item, width(), now);
    const accent = itemTone(node.item);
    node.box.height = lines.length + 1;
    node.text.height = lines.length;
    node.text.content = styled(
      lines.map((line) => {
        if (line.kind === "body") return [dim(line.text)];
        return [accent ? tone(accent, bold(line.text)) : bold(line.text)];
      }),
    );
  };

  const addNode = (item: FeedItem) => {
    const box = new BoxRenderable(renderer, {
      id: `feed-item-${item.id}`,
      flexShrink: 0,
      onMouseDown: () => actions.open(item.id),
    });
    const text = createText(renderer, `feed-item-text-${item.id}`, 1, false);
    box.add(text);
    list.add(box);
    const node = { item, box, text };
    nodes.push(node);
    paintItem(node);
  };

  const rebuild = () => {
    for (const node of nodes) {
      list.remove(node.box);
      node.box.destroyRecursively();
    }
    nodes = [];
    for (const item of visibleItems(items, view())) addNode(item);
  };

  function paint() {
    paintHeader();
    const key = `${width()}|${[...filters].join(",")}|${view().only ?? ""}`;
    if (key !== builtFor) {
      builtFor = key;
      rebuild();
    } else {
      for (const node of nodes) paintItem(node);
    }
    const shown = nodes.length > 0;
    empty.visible = !shown;
    empty.content = styled([
      [dim(items.length === 0 ? "Nothing yet." : "Nothing of these types.")],
    ]);
  }

  renderer.on("resize", paint);
  paint();

  return {
    update(next, nowMs) {
      state = next;
      now = nowMs;
      paint();
    },
    add(fresh) {
      if (fresh.length === 0) return;
      items = [...items, ...fresh].slice(-KEPT_ITEMS);
      const kept = new Set(items.map((item) => item.id));
      // Drop what fell out of the kept items, then add what is new and shown.
      for (const node of nodes.filter((entry) => !kept.has(entry.item.id))) {
        list.remove(node.box);
        node.box.destroyRecursively();
      }
      nodes = nodes.filter((entry) => kept.has(entry.item.id));
      for (const item of visibleItems(fresh, view())) addNode(item);
      paint();
    },
    showMessage(message) {
      empty.visible = true;
      empty.content = styled([[dim(message)]]);
    },
  };
}
