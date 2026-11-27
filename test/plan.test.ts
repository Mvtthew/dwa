import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LAYOUT,
  type LayoutPanes,
  type LayoutPlan,
  layoutChecksum,
  layoutString,
  type PlanInput,
  paneOrder,
  planLayout,
} from "../src/tmux/plan.ts";

const PANES: LayoutPanes = { top: "%4", left: "%0", main: "%1", right: "%2" };
const input = (over: Partial<PlanInput>): PlanInput => ({
  width: 200,
  height: 50,
  sizes: DEFAULT_LAYOUT,
  feed: true,
  shell: false,
  agents: [],
  ...over,
});
const plan = (over: Partial<PlanInput>): LayoutPlan => {
  const made = planLayout(input(over));
  if (!made) throw new Error("no plan");
  return made;
};
const panesFor = (over: Partial<PlanInput>): LayoutPanes => ({
  ...PANES,
  ...(over.feed === false ? {} : { feed: "%3" }),
  ...(over.shell ? { shell: "%9" } : {}),
});

interface Parsed {
  width: number;
  height: number;
  x: number;
  y: number;
  dir?: "h" | "v";
  pane?: string;
  cells: Parsed[];
}

/** Reads a layout string back, so a test can check it the way tmux would. */
function parse(text: string): Parsed {
  let at = 0;
  const cell = (): Parsed => {
    const match = /^(\d+)x(\d+),(\d+),(\d+)/.exec(text.slice(at));
    if (!match) throw new Error(`bad cell at ${at}`);
    at += match[0].length;
    const [width, height, x, y] = match.slice(1).map(Number) as [number, number, number, number];
    const open = text[at];
    if (open === "{" || open === "[") {
      at++;
      const cells = [cell()];
      while (text[at] === ",") {
        at++;
        cells.push(cell());
      }
      at++;
      return { width, height, x, y, dir: open === "{" ? "h" : "v", cells };
    }
    const id = /^,(\d+)/.exec(text.slice(at));
    if (!id) throw new Error(`no pane at ${at}`);
    at += id[0].length;
    return { width, height, x, y, pane: `%${id[1]}`, cells: [] };
  };
  const root = cell();
  if (at !== text.length) throw new Error("text after the layout");
  return root;
}

/** Every container is filled exactly by its cells and the border between each two. */
function check(cell: Parsed): string[] {
  if (cell.pane) {
    expect(cell.width).toBeGreaterThanOrEqual(1);
    expect(cell.height).toBeGreaterThanOrEqual(1);
    return [cell.pane];
  }
  let at = cell.dir === "h" ? cell.x : cell.y;
  for (const child of cell.cells) {
    expect(child.dir).not.toBe(cell.dir);
    if (cell.dir === "h") {
      expect([child.x, child.y, child.height]).toEqual([at, cell.y, cell.height]);
      at += child.width + 1;
    } else {
      expect([child.x, child.y, child.width]).toEqual([cell.x, at, cell.width]);
      at += child.height + 1;
    }
  }
  expect(at - 1).toBe(cell.dir === "h" ? cell.x + cell.width : cell.y + cell.height);
  expect(cell.cells.length).toBeGreaterThan(1);
  return cell.cells.flatMap(check);
}

const body = (text: string) => text.slice(text.indexOf(",") + 1);

describe("the layout plan", () => {
  test("a 200-column window keeps today's sizes, with one agent under main", () => {
    const made = plan({ agents: ["%5"] });
    expect(made).toMatchObject({
      mode: "narrow",
      status: 30,
      agentsList: 34,
      feed: 40,
      main: 93,
      capacity: 1,
      bodyHeight: 47,
      mainHeight: 27,
      under: [{ pane: "%5", height: 19 }],
    });
  });

  test("the side columns grow with the window, up to their cap", () => {
    expect(plan({ width: 240 })).toMatchObject({ status: 36, agentsList: 41, feed: 48 });
    expect(plan({ width: 280 })).toMatchObject({ status: 42, agentsList: 48, feed: 56 });
    expect(plan({ width: 600 })).toMatchObject({ status: 42, agentsList: 48, feed: 56 });
    const fixed = { ...DEFAULT_LAYOUT, sideScaleMax: 100 };
    expect(plan({ width: 600, sizes: fixed })).toMatchObject({ status: 30, agentsList: 34 });
  });

  test("agents go right of main once a column fits beside it", () => {
    expect(plan({ width: 309, agents: ["%5"] }).mode).toBe("narrow");
    const wide = plan({ width: 310, agents: ["%5"] });
    expect(wide).toMatchObject({ mode: "wide", centre: 161, capacity: 2 });
    expect(wide.columns).toEqual([{ width: 70, panes: ["%5"], heights: [47] }]);
    expect(wide.main).toBe(90);
    // Without the feed there is room sooner.
    expect(plan({ width: 239, feed: false }).mode).toBe("narrow");
    expect(plan({ width: 240, feed: false }).mode).toBe("wide");
  });

  test("main and the columns share the width; main keeps its minimum", () => {
    const one = plan({ width: 400, height: 70, agents: ["%5"] });
    expect([one.main, one.columns.map((column) => column.width)]).toEqual([125, [125]]);
    const two = plan({ width: 400, height: 70, agents: ["%5", "%6", "%7"] });
    expect(two.capacity).toBe(4);
    expect([two.main, two.columns.map((column) => column.width)]).toEqual([91, [79, 79]]);
    expect(two.columns.map((column) => column.panes)).toEqual([["%5", "%6"], ["%7"]]);
    expect(two.columns.map((column) => column.heights)).toEqual([[33, 33], [67]]);
    // Only as many columns as the agents need.
    expect(plan({ width: 500, height: 70, agents: ["%5", "%6"] }).columns).toHaveLength(1);
    expect(plan({ width: 500, height: 70 }).capacity).toBe(6);
  });

  test("a low window shows one agent per column", () => {
    const low = plan({ width: 400, height: 19, agents: ["%5", "%6"] });
    expect(low.capacity).toBe(2);
    expect(low.columns.map((column) => column.panes)).toEqual([["%5"], ["%6"]]);
  });

  test("the shell takes a row under main and the agents", () => {
    const wide = plan({ width: 420, height: 70, shell: true, agents: ["%5", "%6"] });
    expect(wide).toMatchObject({ shellHeight: 15, upperHeight: 51, mainHeight: 51 });
    expect(wide.columns[0]?.heights).toEqual([25, 25]);
    const narrow = plan({ shell: true, agents: ["%5"] });
    expect(narrow).toMatchObject({ shellHeight: 12, upperHeight: 34, mainHeight: 19 });
    expect(narrow.under).toEqual([{ pane: "%5", height: 14 }]);
    expect(plan({ height: 20, shell: true }).shellHeight).toBe(6);
  });

  test("more agents than there is room for are still placed", () => {
    const narrow = plan({ agents: ["%5", "%6"] });
    expect(narrow.capacity).toBe(1);
    expect(narrow.under.map((agent) => agent.pane)).toEqual(["%5", "%6"]);
    const wide = plan({ width: 310, height: 70, agents: ["%5", "%6", "%7"] });
    expect(wide.capacity).toBe(2);
    expect(wide.columns.map((column) => column.panes)).toEqual([["%5", "%6", "%7"]]);
  });

  test("a window too small to plan gets none", () => {
    expect(planLayout(input({ width: 59 }))).toBeNull();
    expect(planLayout(input({ height: 15 }))).toBeNull();
    expect(
      planLayout(input({ width: 60, height: 16, shell: true, agents: ["%5"] })),
    ).not.toBeNull();
  });
});

describe("the layout string", () => {
  test("the checksum is tmux's", () => {
    // Strings tmux 3.8 took in spike S13.
    for (const text of [
      "61ab,100x30,0,0{30x30,0,0,0,69x30,31,0,1}",
      "3067,200x50,0,0[200x2,0,0,4,200x47,0,3{30x47,0,3,0,93x47,31,3[93x20,31,3,1,93x14,31,24,8,93x11,31,39,9],34x47,125,3,2,40x47,160,3,3}]",
    ]) {
      expect(layoutChecksum(body(text))).toBe(text.slice(0, 4));
    }
  });

  test("the wide layout of the spike comes out character for character", () => {
    const sizes = { ...DEFAULT_LAYOUT, mainMinWidth: 100, agentMinWidth: 80 };
    const over = { width: 420, height: 70, sizes, shell: true, agents: ["%5", "%6", "%7", "%8"] };
    expect(layoutString(plan(over), panesFor(over))).toBe(
      "b78d,420x70,0,0[420x2,0,0,4,420x67,0,3{42x67,0,3,0,271x67,43,3[271x51,43,3{101x51,43,3,1,84x51,145,3[84x25,145,3,5,84x25,145,29,6],84x51,230,3[84x25,230,3,7,84x25,230,29,8]},271x15,43,55,9],48x67,315,3,2,56x67,364,3,3}]",
    );
  });

  test("without a shell, main and the columns stand straight in the row", () => {
    const over = { width: 400, height: 70, agents: ["%8"] };
    expect(layoutString(plan(over), panesFor(over))).toBe(
      "0c74,400x70,0,0[400x2,0,0,4,400x67,0,3{42x67,0,3,0,125x67,43,3,1,125x67,169,3,8,48x67,295,3,2,56x67,344,3,3}]",
    );
  });

  test("main alone is a plain cell", () => {
    const over = { feed: false };
    expect(body(layoutString(plan(over), panesFor(over)))).toBe(
      "200x50,0,0[200x2,0,0,4,200x47,0,3{30x47,0,3,0,134x47,31,3,1,34x47,166,3,2}]",
    );
  });

  test("every size fills its window, with the panes in the order tmux needs", () => {
    const agents = ["%5", "%6", "%7", "%8", "%10", "%11", "%12"];
    for (let width = 60; width <= 620; width += 7) {
      for (let height = 16; height <= 120; height += 13) {
        for (const feed of [true, false]) {
          for (const shell of [true, false]) {
            for (const count of [0, 1, 2, 4, 7]) {
              const over = { width, height, feed, shell, agents: agents.slice(0, count) };
              const made = planLayout(input(over));
              if (!made) continue;
              const shown = Math.min(count, made.capacity);
              const fitted = plan({ ...over, agents: agents.slice(0, shown) });
              const panes = panesFor(over);
              const root = parse(body(layoutString(fitted, panes)));
              expect([root.width, root.height]).toEqual([width, height]);
              expect(check(root)).toEqual(paneOrder(panes, agents.slice(0, shown)));
              if (fitted.mode === "wide" && shown > 0) {
                expect(fitted.main).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.mainMinWidth);
                for (const column of fitted.columns) {
                  expect(column.width).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.agentMinWidth);
                }
              }
            }
          }
        }
      }
    }
  });

  test("too many agents still give a layout tmux can take", () => {
    for (const over of [
      { agents: ["%5", "%6", "%7"], shell: true },
      { width: 310, height: 40, agents: ["%5", "%6", "%7", "%8"] },
    ]) {
      const panes = panesFor(over);
      const root = parse(body(layoutString(plan(over), panes)));
      expect(check(root)).toEqual(paneOrder(panes, over.agents));
    }
  });
});
