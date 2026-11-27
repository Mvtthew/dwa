/**
 * The workspace window's layout, worked out from the window's size and what is shown. Pure: no
 * tmux call is made here. The plan is turned into one layout string that `select-layout` applies
 * (docs/spikes.md, S13), which is the only way a pane of the workspace window gets its size.
 */

export interface LayoutSizes {
  /** Columns of the status pane on the left, in a window of `REF_WIDTH` columns or fewer. */
  statusWidth: number;
  /** Columns of the agents pane on the right, at that width. */
  agentsWidth: number;
  /** Columns of the event feed, right of the agents pane when it is shown, at that width. */
  feedWidth: number;
  /** Percent of the centre column given to the agent pane under main, in a narrow window. */
  agentHeight: number;
  /** Main is never narrower than this while agents are shown right of it. */
  mainMinWidth: number;
  /** The narrowest a column of agents right of main may be. */
  agentMinWidth: number;
  /** How far the side columns grow with the window, in percent of their width. 100: not at all. */
  sideScaleMax: number;
}

/** Rows of the top bar's text. tmux draws its border line above it. */
export const TOP_BAR_HEIGHT = 1;

export const DEFAULT_LAYOUT: LayoutSizes = {
  statusWidth: 30,
  agentsWidth: 34,
  feedWidth: 40,
  agentHeight: 40,
  mainMinWidth: 90,
  agentMinWidth: 70,
  sideScaleMax: 140,
};

/** The window width at which the side columns have their configured widths; they grow above it. */
export const REF_WIDTH = 200;
/** A window smaller than this is left to tmux: no plan is made for it. */
export const MIN_WINDOW = { width: 60, height: 16 };
/** Agents shown in one column right of main, when the rows allow it. */
export const AGENTS_PER_COLUMN = 2;
/** The fewest rows an agent pane keeps when two share a column. */
const AGENT_MIN_ROWS = 8;
/** The centre column keeps this many columns; the side columns give way first. */
const CENTRE_FLOOR = 40;
const SIDE_FLOOR = 10;
/** The shell's row: a share of the rows under the top bar, within these bounds. */
const SHELL_SHARE = 0.25;
const SHELL_ROWS = { min: 6, max: 15 };

/** Columns of the borders between the columns: one between each two of them. */
export const borders = (feed: boolean) => (feed ? 3 : 2);

export interface PlanInput {
  width: number;
  height: number;
  sizes: LayoutSizes;
  feed: boolean;
  shell: boolean;
  /** Pane ids of the shown agents, in the window's pane order. */
  agents: string[];
}

export interface AgentColumn {
  width: number;
  panes: string[];
  /** Rows of each pane, top to bottom. */
  heights: number[];
}

export interface LayoutPlan {
  width: number;
  height: number;
  /** Wide: agents stand right of main. Narrow: one agent under main. */
  mode: "narrow" | "wide";
  status: number;
  main: number;
  agentsList: number;
  feed: number | null;
  /** Columns between the status pane and the agents pane. */
  centre: number;
  /** Rows under the top bar and its border. */
  bodyHeight: number;
  /** Rows of the centre above the shell's row: all of them without a shell. */
  upperHeight: number;
  shellHeight: number | null;
  mainHeight: number;
  /** How many agents the window has room for. More than that are still placed, tightly. */
  capacity: number;
  /** Wide: the columns right of main. */
  columns: AgentColumn[];
  /** Narrow: the agents under main (one, unless more are shown than there is room for). */
  under: { pane: string; height: number }[];
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Splits `total` rows among `count` panes with a border row between them; the first takes the rest. */
function stack(total: number, count: number): number[] {
  const each = Math.max(1, Math.floor((total - (count - 1)) / count));
  const first = Math.max(1, total - (count - 1) - each * (count - 1));
  return [first, ...Array<number>(count - 1).fill(each)];
}

function sideWidths(input: PlanInput): { status: number; agentsList: number; feed: number } {
  const { sizes, width } = input;
  const scale = clamp(width / REF_WIDTH, 1, Math.max(1, sizes.sideScaleMax / 100));
  let status = Math.round(sizes.statusWidth * scale);
  let agentsList = Math.round(sizes.agentsWidth * scale);
  let feed = input.feed ? Math.round(sizes.feedWidth * scale) : 0;
  const room = width - borders(input.feed) - CENTRE_FLOOR;
  const sides = status + agentsList + feed;
  if (sides > room) {
    const factor = Math.max(0, room) / sides;
    status = Math.max(SIDE_FLOOR, Math.floor(status * factor));
    agentsList = Math.max(SIDE_FLOOR, Math.floor(agentsList * factor));
    if (input.feed) feed = Math.max(SIDE_FLOOR, Math.floor(feed * factor));
  }
  return { status, agentsList, feed };
}

/**
 * Where everything goes in a window of this size. Null when the window is too small to plan
 * (tmux then keeps what it has), or when what is shown cannot fit in it at all.
 */
export function planLayout(input: PlanInput): LayoutPlan | null {
  const { width, height, sizes } = input;
  if (width < MIN_WINDOW.width || height < MIN_WINDOW.height) return null;
  const sides = sideWidths(input);
  const centre = width - sides.status - sides.agentsList - sides.feed - borders(input.feed);
  // The top bar's cell holds its border title and its text, and a border row follows it.
  const bodyHeight = height - (TOP_BAR_HEIGHT + 1) - 1;
  const shellHeight = input.shell
    ? clamp(Math.round(bodyHeight * SHELL_SHARE), SHELL_ROWS.min, SHELL_ROWS.max)
    : null;
  const upperHeight = shellHeight === null ? bodyHeight : bodyHeight - 1 - shellHeight;
  const shown = input.agents.length;

  const maxColumns = Math.max(
    0,
    Math.floor((centre - sizes.mainMinWidth) / (sizes.agentMinWidth + 1)),
  );
  const base = {
    width,
    height,
    status: sides.status,
    agentsList: sides.agentsList,
    feed: input.feed ? sides.feed : null,
    centre,
    bodyHeight,
    upperHeight,
    shellHeight,
  };

  if (maxColumns >= 1) {
    const perColumn = upperHeight >= 2 * AGENT_MIN_ROWS + 1 ? AGENTS_PER_COLUMN : 1;
    const used = Math.min(maxColumns, Math.ceil(shown / perColumn));
    if (upperHeight < 1) return null;
    if (used === 0) {
      return {
        ...base,
        mode: "wide",
        main: centre,
        mainHeight: upperHeight,
        capacity: maxColumns * perColumn,
        columns: [],
        under: [],
      };
    }
    // Main and the columns share the centre equally, but main never goes under its minimum.
    let column = Math.floor((centre - used) / (used + 1));
    if (centre - used - used * column < sizes.mainMinWidth) {
      column = Math.floor((centre - used - sizes.mainMinWidth) / used);
    }
    const main = centre - used - used * column;
    const columns: AgentColumn[] = [];
    for (let index = 0; index < used; index++) {
      // Agents beyond the room there is all go to the last column.
      const from = index * perColumn;
      const panes = input.agents.slice(from, index === used - 1 ? undefined : from + perColumn);
      if (upperHeight < panes.length * 2 - 1) return null;
      columns.push({ width: column, panes, heights: stack(upperHeight, panes.length) });
    }
    return {
      ...base,
      mode: "wide",
      main,
      mainHeight: upperHeight,
      capacity: maxColumns * perColumn,
      columns,
      under: [],
    };
  }

  if (shown === 0) {
    if (upperHeight < 1) return null;
    return {
      ...base,
      mode: "narrow",
      main: centre,
      mainHeight: upperHeight,
      capacity: 1,
      columns: [],
      under: [],
    };
  }
  // Each agent needs a row and a border row, and main a row of its own.
  const least = shown * 2 - 1;
  if (upperHeight < least + 2) return null;
  const share = Math.round((upperHeight * sizes.agentHeight) / 100);
  const agentRows = clamp(share, least, upperHeight - 2);
  const heights = stack(agentRows, shown);
  return {
    ...base,
    mode: "narrow",
    main: centre,
    mainHeight: upperHeight - 1 - agentRows,
    capacity: 1,
    columns: [],
    under: input.agents.map((pane, index) => ({ pane, height: heights[index] ?? 1 })),
  };
}

/** The panes of the frame, by tmux pane id. The agents are named by the plan. */
export interface LayoutPanes {
  top: string;
  left: string;
  main: string;
  right: string;
  feed?: string;
  shell?: string;
}

/**
 * The order the workspace window's panes must have for a plan's layout string: tmux gives the
 * cells of a layout to the panes in their order, whatever ids the string names.
 */
export function paneOrder(panes: LayoutPanes, agents: string[]): string[] {
  return [
    panes.top,
    panes.left,
    panes.main,
    ...agents,
    ...(panes.shell ? [panes.shell] : []),
    panes.right,
    ...(panes.feed ? [panes.feed] : []),
  ];
}

/** tmux's checksum of a layout: a 16-bit sum, rotated right by one before each character. */
export function layoutChecksum(body: string): string {
  let sum = 0;
  for (let index = 0; index < body.length; index++) {
    sum = (sum >> 1) | ((sum & 1) << 15);
    sum = (sum + body.charCodeAt(index)) & 0xffff;
  }
  return sum.toString(16).padStart(4, "0");
}

/** A cell of the layout: a pane, or cells side by side ("h") or above each other ("v"). */
type Cell = { size: number; pane: string } | { size: number; dir: "h" | "v"; cells: Cell[] };

/** One cell alone needs no container around it. */
function group(size: number, dir: "h" | "v", cells: Cell[]): Cell {
  const [only] = cells;
  return cells.length === 1 && only ? { ...only, size } : { size, dir, cells };
}

function print(cell: Cell, x: number, y: number, width: number, height: number): string {
  const base = `${width}x${height},${x},${y}`;
  if ("pane" in cell) return `${base},${cell.pane.replace("%", "")}`;
  let at = cell.dir === "h" ? x : y;
  const parts = cell.cells.map((child) => {
    const part =
      cell.dir === "h"
        ? print(child, at, y, child.size, height)
        : print(child, x, at, width, child.size);
    at += child.size + 1;
    return part;
  });
  return cell.dir === "h" ? `${base}{${parts.join(",")}}` : `${base}[${parts.join(",")}]`;
}

/**
 * The plan as a tmux layout string. The panes must be in the window in `paneOrder`, and the
 * shell and the feed named exactly when the plan was made with them.
 */
export function layoutString(plan: LayoutPlan, panes: LayoutPanes): string {
  const shell: Cell[] =
    plan.shellHeight !== null && panes.shell ? [{ size: plan.shellHeight, pane: panes.shell }] : [];
  let centre: Cell[];
  if (plan.mode === "wide") {
    const upper: Cell[] = [
      { size: plan.main, pane: panes.main },
      ...plan.columns.map((column) =>
        group(
          column.width,
          "v",
          column.panes.map((pane, index) => ({ size: column.heights[index] ?? 1, pane })),
        ),
      ),
    ];
    // With a shell its row lies under main and the columns; without one they stand in the row.
    centre =
      shell.length > 0
        ? [group(plan.centre, "v", [group(plan.upperHeight, "h", upper), ...shell])]
        : upper;
  } else {
    centre = [
      group(plan.centre, "v", [
        { size: plan.mainHeight, pane: panes.main },
        ...plan.under.map((agent) => ({ size: agent.height, pane: agent.pane })),
        ...shell,
      ]),
    ];
  }
  const body: Cell = {
    size: plan.bodyHeight,
    dir: "h",
    cells: [
      { size: plan.status, pane: panes.left },
      ...centre,
      { size: plan.agentsList, pane: panes.right },
      ...(plan.feed !== null && panes.feed ? [{ size: plan.feed, pane: panes.feed }] : []),
    ],
  };
  const window: Cell = {
    size: plan.height,
    dir: "v",
    cells: [{ size: TOP_BAR_HEIGHT + 1, pane: panes.top }, body],
  };
  const text = print(window, 0, 0, plan.width, plan.height);
  return `${layoutChecksum(text)},${text}`;
}
