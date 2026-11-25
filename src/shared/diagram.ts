// A workflow as a picture made of characters: steps as boxes in layers from top to bottom,
// a line from each step to the steps that depend on it, and a review drawn as a line back up
// the right-hand side. Pure: the same layout is printed by `dwa workflow show` and drawn, with
// colours and a pointer, by the designer.
import type { WorkflowDefinition, WorkflowProblem } from "./workflow.ts";
import { DEFAULT_MAX_ROUNDS } from "./workflow.ts";

export type DiagramTone = "good" | "muted" | "attention" | "bad";

export interface DiagramStep {
  id: string;
  dependsOn: string[];
  /** The step this one reviews, and after how many passes the user is asked. */
  reviews?: string;
  rounds?: number;
  /** Second line of the box: the role, or in a run the agent. */
  detail?: string;
  /** Before the name: the state of the step in a run. */
  lead?: string;
  /** At the right of the first line: a problem sign, or the pass number in a run. */
  mark?: string;
  /** At the right of the second line: signs for what the step has set. */
  note?: string;
  /** Colours `lead` and `mark`. */
  tone?: DiagramTone;
}

export interface DiagramInput {
  /** In file order. */
  steps: DiagramStep[];
}

/** A place a step that was picked up can be put down. */
export type Slot =
  /** On a line: between the two steps it joins. */
  | { kind: "edge"; from: string; to: string }
  /** At a box's top right corner: next to that step, depending on what it depends on. */
  | { kind: "beside"; step: string }
  /** Under a box: depending on that step alone. */
  | { kind: "below"; step: string };

export interface DiagramOptions {
  /** The step the cursor is on: marked with a bar and shown in inverse video. */
  selected?: string | null;
  /** The step a line is being drawn from: marked with the bar while the cursor moves on. */
  origin?: string | null;
  /** A line the cursor is on, shown in inverse video. */
  picked?: Region | null;
  /** The step that was picked up: its box is dimmed and the places it can go are marked. */
  carrying?: string | null;
  /** Which of `Diagram.slots` the cursor is on. */
  slotCursor?: number;
}

export interface Cell {
  char: string;
  tone?: DiagramTone;
  inverse?: boolean;
  dim?: boolean;
}

/** Something on the picture a pointer can be on. */
export type Region =
  | { kind: "step"; id: string }
  /** The line from `from` to `to`, which depends on it. */
  | { kind: "edge"; from: string; to: string }
  /** The line from a review step back to the step it reviews. */
  | { kind: "review"; from: string; to: string }
  /** A place to put a step down: `Diagram.slots[index]`. */
  | { kind: "slot"; index: number };

export interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
}

export interface Diagram {
  width: number;
  height: number;
  /** Rows of cells, `height` by `width`. */
  cells: Cell[][];
  boxes: Box[];
  /** What is at each cell, where there is something to point at. */
  regions: (Region | null)[][];
  /** With a step picked up: where it can go, from the top left to the bottom right. */
  slots: { slot: Slot; x: number; y: number }[];
}

/** The sign a place to put a step down is marked with. */
export const SLOT_MARK = "◆";

/** True when two regions are the same thing on the picture. */
export function sameRegion(a: Region | null | undefined, b: Region | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

const BOX_HEIGHT = 4;
const GAP = 3;
const MIN_WIDTH = 13;
const MAX_WIDTH = 26;
/** Columns between two lines that go back up for reviews. */
const LANE = 5;

const N = 1;
const E = 2;
const S = 4;
const W = 8;
/** The line character for each set of directions a cell is joined in. */
const LINES: Record<number, string> = {
  [N]: "│",
  [S]: "│",
  [N | S]: "│",
  [E]: "─",
  [W]: "─",
  [E | W]: "─",
  [N | E]: "╰",
  [N | W]: "╯",
  [S | E]: "╭",
  [S | W]: "╮",
  [N | S | E]: "├",
  [N | S | W]: "┤",
  [E | W | S]: "┬",
  [E | W | N]: "┴",
  [N | E | S | W]: "┼",
};

function fit(text: string, max: number): string {
  if (max <= 0) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A step, or the place where a line passes a layer on its way to a step further down. */
interface Item {
  step: DiagramStep | null;
  /** For a pass: the dependency whose line it carries. */
  edge: { from: string; to: string } | null;
  layer: number;
  parents: Item[];
  children: { item: Item; edge: { from: string; to: string } }[];
  x: number;
  width: number;
  /** The column lines enter and leave at. */
  cx: number;
}

/** The steps in layers: a step is one layer below the lowest step it depends on. */
function layers(input: DiagramInput): Item[][] {
  const byId = new Map(input.steps.map((step) => [step.id, step]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    // A loop has no top; the step it is found at is treated as one so a picture comes out.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let level = 0;
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (dependency !== id && byId.has(dependency)) {
        level = Math.max(level, depthOf(dependency) + 1);
      }
    }
    visiting.delete(id);
    depth.set(id, level);
    return level;
  };
  // A loop can leave a layer with nothing in it; the layers are counted without the gaps.
  for (const step of input.steps) depthOf(step.id);
  const used = [...new Set(depth.values())].sort((a, b) => a - b);
  for (const [id, level] of depth) depth.set(id, used.indexOf(level));
  const rows: Item[][] = [];
  const items = new Map<string, Item>();
  const place = (item: Item) => {
    while (rows.length <= item.layer) rows.push([]);
    (rows[item.layer] as Item[]).push(item);
  };
  for (const step of input.steps) {
    const item: Item = {
      step,
      edge: null,
      layer: depthOf(step.id),
      parents: [],
      children: [],
      x: 0,
      width: 0,
      cx: 0,
    };
    items.set(step.id, item);
    place(item);
  }
  for (const step of input.steps) {
    const to = items.get(step.id) as Item;
    for (const dependency of new Set(step.dependsOn)) {
      const from = items.get(dependency);
      if (!from || from === to || from.layer >= to.layer) continue;
      const edge = { from: dependency, to: step.id };
      let previous = from;
      for (let layer = from.layer + 1; layer < to.layer; layer++) {
        const pass: Item = {
          step: null,
          edge,
          layer,
          parents: [previous],
          children: [],
          x: 0,
          width: 1,
          cx: 0,
        };
        previous.children.push({ item: pass, edge });
        place(pass);
        previous = pass;
      }
      previous.children.push({ item: to, edge });
      to.parents.push(previous);
    }
  }
  // One sweep down: an item goes under the middle of what it comes from, file order otherwise.
  for (let layer = 1; layer < rows.length; layer++) {
    const above = rows[layer - 1] as Item[];
    const row = rows[layer] as Item[];
    const middle = (item: Item) =>
      item.parents.length === 0
        ? Number.POSITIVE_INFINITY
        : item.parents.reduce((sum, parent) => sum + above.indexOf(parent), 0) /
          item.parents.length;
    const order = new Map(row.map((item, index) => [item, index]));
    row.sort((a, b) => middle(a) - middle(b) || (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }
  return rows;
}

function boxWidth(input: DiagramInput): number {
  let width = MIN_WIDTH;
  for (const step of input.steps) {
    const first = (step.lead ? step.lead.length + 1 : 0) + step.id.length + gapFor(step.mark);
    const second = (step.detail?.length ?? 0) + gapFor(step.note);
    width = Math.max(width, Math.max(first, second) + 4);
  }
  return Math.min(width, MAX_WIDTH);
}

function gapFor(text: string | undefined): number {
  return text ? text.length + 1 : 0;
}

/** A line back up from a review step to the step it reviews. */
interface Back {
  from: Item;
  to: Item;
  rounds: number;
  /** Leaves from the side of the box; otherwise from under it, on a row of its own. */
  sideExit: boolean;
  sideEntry: boolean;
  exitRow: number;
  entryRow: number;
  lane: number;
}

/** Lays the steps out and draws them. */
export function layoutDiagram(input: DiagramInput, options: DiagramOptions = {}): Diagram {
  const rows = layers(input);
  const width = boxWidth(input);
  const stepItems = new Map<string, Item>();
  for (const row of rows) {
    for (const item of row) {
      if (item.step) {
        item.width = width;
        stepItems.set(item.step.id, item);
      }
    }
  }
  const rowWidth = (row: Item[]) =>
    row.reduce((sum, item) => sum + item.width, 0) + GAP * Math.max(0, row.length - 1);
  const inner = Math.max(0, ...rows.map(rowWidth));
  for (const row of rows) {
    let x = Math.floor((inner - rowWidth(row)) / 2);
    for (const item of row) {
      item.x = x;
      item.cx = x + Math.floor(item.width / 2);
      x += item.width + GAP;
    }
  }

  // Reviews: from the side of a box when nothing is to its right, otherwise over or under it.
  const backs: Back[] = [];
  const entries = new Map<Item, number>();
  for (const step of input.steps) {
    const from = stepItems.get(step.id) as Item;
    const to = step.reviews === undefined ? undefined : stepItems.get(step.reviews);
    if (!to || to.layer >= from.layer) continue;
    const last = (item: Item) => (rows[item.layer] as Item[]).at(-1) === item;
    const used = entries.get(to) ?? 0;
    const sideEntry = last(to) && used < 2;
    if (sideEntry) entries.set(to, used + 1);
    backs.push({
      from,
      to,
      rounds: step.rounds ?? DEFAULT_MAX_ROUNDS,
      sideExit: last(from),
      sideEntry,
      exitRow: 0,
      entryRow: sideEntry ? used : 0,
      lane: 0,
    });
  }
  // The shortest goes nearest the boxes, so the lines cross as little as they can.
  backs.sort((a, b) => a.from.layer - a.to.layer - (b.from.layer - b.to.layer));
  backs.forEach((back, index) => {
    back.lane = inner + LANE + index * LANE;
  });

  // Rows: for each layer the rows reviews come in on, the boxes, the rows reviews leave on,
  // and one row for every step whose lines to the next layer have to go sideways.
  const boxY: number[] = [];
  const busRows = new Map<Item, number>();
  let y = 0;
  rows.forEach((row, layer) => {
    for (const back of backs) {
      if (back.to.layer === layer && !back.sideEntry) back.entryRow = y++;
    }
    boxY[layer] = y;
    y += BOX_HEIGHT;
    for (const back of backs) {
      if (back.from.layer === layer && !back.sideExit) back.exitRow = y++;
    }
    if (layer === rows.length - 1) return;
    const sideways = row
      .filter((item) => item.children.some((child) => child.item.cx !== item.cx))
      .sort((a, b) => a.cx - b.cx);
    for (const item of sideways) busRows.set(item, y++);
    if (sideways.length === 0) y += 1;
  });
  const height = y;
  const fullWidth = backs.length > 0 ? Math.max(...backs.map((back) => back.lane)) + 1 : inner;

  const cells: Cell[][] = Array.from({ length: height }, () =>
    Array.from({ length: fullWidth }, () => ({ char: " " })),
  );
  const regions: (Region | null)[][] = Array.from({ length: height }, () =>
    Array.from({ length: fullWidth }, () => null),
  );
  const masks: number[][] = Array.from({ length: height }, () =>
    Array.from({ length: fullWidth }, () => 0),
  );
  const join = (x: number, row: number, bits: number, region: Region, own = true) => {
    const line = masks[row];
    if (!line || x < 0 || x >= fullWidth) return;
    line[x] = (line[x] ?? 0) | bits;
    const regionRow = regions[row] as (Region | null)[];
    // A stretch several lines share belongs to the first; each line's own part to itself.
    if (own || regionRow[x] === null) regionRow[x] = region;
  };
  const vertical = (x: number, from: number, to: number, region: Region, own = true) => {
    for (let row = from; row <= to; row++) {
      join(x, row, (row > from ? N : 0) | (row < to ? S : 0), region, own);
    }
  };
  const horizontal = (row: number, from: number, to: number, region: Region, own = true) => {
    const [left, right] = from <= to ? [from, to] : [to, from];
    for (let x = left; x <= right; x++) {
      join(x, row, (x > left ? W : 0) | (x < right ? E : 0), region, own);
    }
  };
  const put = (x: number, row: number, cell: Cell, region?: Region) => {
    const line = cells[row];
    if (!line || x < 0 || x >= fullWidth) return;
    line[x] = cell;
    if (region) (regions[row] as (Region | null)[])[x] = region;
  };

  // Lines between the layers.
  rows.forEach((row, layer) => {
    const top = boxY[layer] as number;
    const bottom = top + BOX_HEIGHT - 1;
    for (const item of row) {
      if (!item.step && item.edge) {
        vertical(item.cx, top, bottom, { kind: "edge", ...item.edge });
      }
      if (item.children.length === 0) continue;
      const nextTop = boxY[layer + 1] as number;
      // A box's line starts under its border; a pass is a line already.
      const start = item.step ? bottom + 1 : bottom;
      const trunk: Region = { kind: "edge", ...(item.children[0] as Item["children"][0]).edge };
      const bus = busRows.get(item);
      if (item.step) join(item.cx, start, N, trunk, false);
      for (const child of item.children) {
        const region: Region = { kind: "edge", ...child.edge };
        const end = child.item.step ? nextTop - 1 : nextTop;
        if (bus === undefined) {
          vertical(item.cx, start, end, region);
        } else {
          vertical(item.cx, start, bus, trunk, item.children.length === 1);
          horizontal(bus, item.cx, child.item.cx, region, item.children.length === 1);
          vertical(child.item.cx, bus, end, region);
        }
        if (child.item.step) join(child.item.cx, end, S, region);
      }
    }
  });

  // Lines back up for reviews.
  for (const back of backs) {
    const region: Region = {
      kind: "review",
      from: (back.from.step as DiagramStep).id,
      to: (back.to.step as DiagramStep).id,
    };
    const fromTop = boxY[back.from.layer] as number;
    const toTop = boxY[back.to.layer] as number;
    const fromRight = back.from.x + back.from.width - 1;
    const toRight = back.to.x + back.to.width - 1;
    let low: number;
    let high: number;
    if (back.sideExit) {
      low = fromTop + 2;
      horizontal(low, fromRight + 1, back.lane, region);
      join(fromRight + 1, low, W, region);
    } else {
      low = back.exitRow;
      const x = fromRight - 2;
      vertical(x, fromTop + BOX_HEIGHT, low, region);
      join(x, fromTop + BOX_HEIGHT, N, region);
      horizontal(low, x, back.lane, region);
    }
    if (back.sideEntry) {
      high = toTop + 1 + back.entryRow;
      horizontal(high, toRight + 2, back.lane, region);
      join(toRight + 2, high, W, region);
    } else {
      high = back.entryRow;
      const x = toRight - 2;
      horizontal(high, x, back.lane, region);
      vertical(x, high, toTop - 1, region);
      join(x, toTop - 1, S, region);
    }
    vertical(back.lane, high, low, region);
  }

  for (let row = 0; row < height; row++) {
    for (let x = 0; x < fullWidth; x++) {
      const mask = (masks[row] as number[])[x] as number;
      if (mask !== 0) (cells[row] as Cell[])[x] = { char: LINES[mask] ?? "┼" };
    }
  }

  // Boxes go over the lines, with the places lines meet them.
  const boxes: Box[] = [];
  for (const [id, item] of stepItems) {
    const step = item.step as DiagramStep;
    const top = boxY[item.layer] as number;
    const right = item.x + item.width - 1;
    const region: Region = { kind: "step", id };
    const selected = options.selected === id;
    boxes.push({ id, x: item.x, y: top, width: item.width, height: BOX_HEIGHT, layer: item.layer });
    for (let x = item.x; x <= right; x++) {
      const edge = x === item.x || x === right;
      put(x, top, { char: edge ? (x === item.x ? "╭" : "╮") : "─" }, region);
      put(x, top + 3, { char: edge ? (x === item.x ? "╰" : "╯") : "─" }, region);
    }
    const room = item.width - 4;
    const lines: { text: string; right: string; lead: string }[] = [
      { text: step.id, right: step.mark ?? "", lead: step.lead ? `${step.lead} ` : "" },
      { text: step.detail ?? "", right: step.note ?? "", lead: "" },
    ];
    lines.forEach((line, index) => {
      const row = top + 1 + index;
      put(item.x, row, { char: "│" }, region);
      put(right, row, { char: "│" }, region);
      const sign = fit(line.right, room);
      const left = fit(line.lead + line.text, room - (sign ? sign.length + 1 : 0));
      const body = left.padEnd(room - sign.length) + sign;
      // The bar says "selected" where inverse video is not shown, as in printed text.
      put(
        item.x + 1,
        row,
        { char: selected || options.origin === id ? "▌" : " ", inverse: false },
        region,
      );
      [...body, " "].forEach((char, offset) => {
        const inLead = index === 0 && offset < line.lead.trimEnd().length;
        const inSign = sign !== "" && offset >= body.length - sign.length && offset < body.length;
        put(
          item.x + 2 + offset,
          row,
          {
            char,
            inverse: selected && index === 0,
            dim: index === 1 && !inSign,
            tone: index === 0 && (inLead || inSign) ? step.tone : undefined,
          },
          region,
        );
      });
    });
  }
  rows.forEach((row, layer) => {
    const top = boxY[layer] as number;
    for (const item of row) {
      if (!item.step) continue;
      if (item.parents.length > 0) put(item.cx, top, { char: "▼" });
      if (item.children.length > 0) put(item.cx, top + 3, { char: "┬" });
    }
  });
  for (const back of backs) {
    const region: Region = {
      kind: "review",
      from: (back.from.step as DiagramStep).id,
      to: (back.to.step as DiagramStep).id,
    };
    const fromTop = boxY[back.from.layer] as number;
    const toTop = boxY[back.to.layer] as number;
    const fromRight = back.from.x + back.from.width - 1;
    const toRight = back.to.x + back.to.width - 1;
    if (back.sideExit) put(fromRight, fromTop + 2, { char: "├" }, region);
    else put(fromRight - 2, fromTop + 3, { char: "┬" }, region);
    if (back.sideEntry) put(toRight + 1, toTop + 1 + back.entryRow, { char: "◀" }, region);
    else put(toRight - 2, toTop, { char: "▼" }, region);
    // How many passes, written into the top stretch just before it turns down.
    const label = `×${back.rounds}`;
    const row = back.sideEntry ? toTop + 1 + back.entryRow : back.entryRow;
    [...label].forEach((char, offset) => {
      put(back.lane - 1 - label.length + offset, row, { char, tone: "attention" }, region);
    });
  }
  if (options.picked && options.picked.kind !== "step") {
    for (let row = 0; row < height; row++) {
      for (let x = 0; x < fullWidth; x++) {
        if (!sameRegion((regions[row] as (Region | null)[])[x], options.picked)) continue;
        const cell = (cells[row] as Cell[])[x] as Cell;
        (cells[row] as Cell[])[x] = { ...cell, inverse: true };
      }
    }
  }

  const slots: Diagram["slots"] = [];
  const carrying = options.carrying;
  if (carrying != null) {
    for (const box of boxes) {
      if (box.id === carrying) {
        for (let row = box.y; row < box.y + box.height; row++) {
          for (let x = box.x; x < box.x + box.width; x++) {
            const cell = (cells[row] as Cell[])[x] as Cell;
            (cells[row] as Cell[])[x] = { ...cell, dim: true, inverse: false };
          }
        }
        continue;
      }
      slots.push({ slot: { kind: "beside", step: box.id }, x: box.x + box.width - 1, y: box.y });
      slots.push({ slot: { kind: "below", step: box.id }, x: box.x + 2, y: box.y + 3 });
    }
    // On each line, at its last cell before the step it leads to.
    const seen = new Set<string>();
    for (let row = height - 1; row >= 0; row--) {
      for (let x = 0; x < fullWidth; x++) {
        const region = (regions[row] as (Region | null)[])[x];
        if (region?.kind !== "edge" || region.from === carrying || region.to === carrying) continue;
        const key = `${region.from}>${region.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        slots.push({ slot: { kind: "edge", from: region.from, to: region.to }, x, y: row });
      }
    }
    slots.sort((a, b) => a.y - b.y || a.x - b.x);
    slots.forEach((slot, index) => {
      put(
        slot.x,
        slot.y,
        { char: SLOT_MARK, tone: "attention", inverse: index === options.slotCursor },
        { kind: "slot", index },
      );
    });
  }
  return { width: fullWidth, height, cells, boxes, regions, slots };
}

/** The picture as lines of text, for a terminal without colours. */
export function diagramText(diagram: Diagram): string[] {
  return diagram.cells.map((row) =>
    row
      .map((cell) => cell.char)
      .join("")
      .trimEnd(),
  );
}

/** What is at a place on the picture, or null. */
export function hit(diagram: Diagram, x: number, y: number): Region | null {
  return diagram.regions[y]?.[x] ?? null;
}

/**
 * The step the cursor goes to from `id`: up and down to the nearest step of the layer above
 * or below (one it is joined to when there is one), left and right along its own layer.
 */
export function neighbour(
  diagram: Diagram,
  input: DiagramInput,
  id: string,
  direction: "up" | "down" | "left" | "right",
): string | null {
  const box = diagram.boxes.find((candidate) => candidate.id === id);
  if (!box) return diagram.boxes[0]?.id ?? null;
  const centre = (other: Box) => other.x + other.width / 2;
  if (direction === "left" || direction === "right") {
    const row = diagram.boxes
      .filter((other) => other.layer === box.layer)
      .sort((a, b) => a.x - b.x);
    return row[row.indexOf(box) + (direction === "left" ? -1 : 1)]?.id ?? null;
  }
  const step = input.steps.find((candidate) => candidate.id === id);
  const joined = (other: Box) =>
    direction === "up"
      ? (step?.dependsOn.includes(other.id) ?? false)
      : (input.steps.find((candidate) => candidate.id === other.id)?.dependsOn.includes(id) ??
        false);
  const away = (other: Box) =>
    direction === "up" ? box.layer - other.layer : other.layer - box.layer;
  const candidates = diagram.boxes
    .filter((other) => away(other) > 0)
    .sort(
      (a, b) =>
        Number(joined(b)) - Number(joined(a)) ||
        away(a) - away(b) ||
        Math.abs(centre(a) - centre(box)) - Math.abs(centre(b) - centre(box)),
    );
  return candidates[0]?.id ?? null;
}

/** The signs a step's box carries in a definition; the designer's footer explains them. */
export const MARKS = { problem: "!", keepsAgent: "∞", ownSettings: "≡" } as const;

const OWN_SETTINGS = [
  "profile",
  "model",
  "effort",
  "permission_mode",
  "tools",
  "deny_tools",
  "allow",
  "deny",
  "mcp",
  "plugins",
  "skills",
  "off_mcp",
  "off_plugins",
  "off_skills",
  "memory",
  "subagents",
] as const;

/** A definition as the picture's input: the role on the second line, signs for the rest. */
export function fromDefinition(
  definition: WorkflowDefinition,
  problems: WorkflowProblem[] = [],
): DiagramInput {
  return {
    steps: Object.entries(definition.steps).map(([id, step]) => {
      const own = OWN_SETTINGS.some((key) => step[key] !== undefined);
      const wrong = problems.some((problem) => problem.step === id);
      return {
        id,
        dependsOn: step.depends_on,
        reviews: step.reviews,
        rounds: step.max_rounds,
        detail: step.role ?? "no role",
        mark: wrong ? MARKS.problem : undefined,
        note:
          `${step.keep_agent ? MARKS.keepsAgent : ""}${own ? MARKS.ownSettings : ""}` || undefined,
        tone: wrong ? "bad" : undefined,
      };
    }),
  };
}
