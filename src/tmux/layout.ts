import { APP_NAME } from "../shared/constants.ts";
import { tmuxQuote } from "./conf.ts";
import type { TmuxRunner } from "./driver.ts";
import { TOP_BAR_HEIGHT } from "./plan.ts";

export const SESSION = APP_NAME;
export const WORKSPACE_WINDOW = "workspace";
export {
  borders,
  DEFAULT_LAYOUT,
  type LayoutPanes,
  type LayoutSizes,
  TOP_BAR_HEIGHT,
} from "./plan.ts";

/** The workspace window as a tmux target, whichever pane of it is active. */
export const WORKSPACE_TARGET = `=${SESSION}:${WORKSPACE_WINDOW}`;

const PRINT_PANE = ["-P", "-F", "#{pane_id}"];

export interface PaneCommand {
  argv: string[];
  env?: Record<string, string>;
  /** Shown in the pane border. */
  title: string;
}

function envArgs(env: Record<string, string> = {}): string[] {
  return Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

export async function hasSession(run: TmuxRunner): Promise<boolean> {
  try {
    await run(["has-session", "-t", `=${SESSION}`]);
    return true;
  } catch {
    return false;
  }
}

export interface WorkspacePanes {
  top: string;
  left: string;
  main: string;
  right: string;
  /** The event feed, when the workspace starts with it shown. */
  feed?: string;
}

/**
 * Creates the session with the top bar across the whole width and the columns under it: status
 * pane, main session, agents pane, and the feed. The panes come out in the order a layout needs
 * (`paneOrder`); their sizes are the caller's to set, with `applyLayout`.
 */
export async function createWorkspace(
  run: TmuxRunner,
  options: {
    cwd: string;
    top: PaneCommand;
    left: PaneCommand;
    main: PaneCommand;
    right: PaneCommand;
    /** Shown right of the agents pane from the start. */
    feed?: PaneCommand;
  },
): Promise<WorkspacePanes> {
  const { cwd } = options;
  const left = await run([
    "new-session",
    "-d",
    "-s",
    SESSION,
    "-n",
    WORKSPACE_WINDOW,
    "-x",
    "200",
    "-y",
    "50",
    "-c",
    cwd,
    ...envArgs(options.left.env),
    ...PRINT_PANE,
    "--",
    ...options.left.argv,
  ]);
  const main = await run([
    "split-window",
    "-h",
    "-t",
    left,
    "-c",
    cwd,
    ...envArgs(options.main.env),
    ...PRINT_PANE,
    "--",
    ...options.main.argv,
  ]);
  const right = await run([
    "split-window",
    "-d",
    "-h",
    "-t",
    main,
    "-c",
    cwd,
    ...envArgs(options.right.env),
    ...PRINT_PANE,
    "--",
    ...options.right.argv,
  ]);
  const feed = options.feed
    ? await run([
        "split-window",
        "-d",
        "-h",
        "-t",
        right,
        "-c",
        cwd,
        ...envArgs(options.feed.env),
        ...PRINT_PANE,
        "--",
        ...options.feed.argv,
      ])
    : undefined;
  if (feed && options.feed) await setTitle(run, feed, options.feed.title);
  // Full width (-f) and above the columns (-b): one row over all of them.
  const top = await run([
    "split-window",
    "-d",
    "-f",
    "-v",
    "-b",
    "-l",
    String(TOP_BAR_HEIGHT),
    "-t",
    left,
    "-c",
    cwd,
    ...envArgs(options.top.env),
    ...PRINT_PANE,
    "--",
    ...options.top.argv,
  ]);
  await setTitle(run, top, options.top.title);
  await setTitle(run, left, options.left.title);
  await setTitle(run, main, options.main.title);
  await setTitle(run, right, options.right.title);
  return { top, left, main, right, feed };
}

export interface WindowInfo {
  width: number;
  height: number;
  /** One pane has the whole window for now; a layout applied now would end that. */
  zoomed: boolean;
}

/** The workspace window's size, as tmux has it now (with no terminal attached, the last one). */
export async function windowInfo(run: TmuxRunner): Promise<WindowInfo> {
  const output = await run([
    "display-message",
    "-p",
    "-t",
    WORKSPACE_TARGET,
    "#{window_width} #{window_height} #{window_zoomed_flag}",
  ]);
  const [width = "", height = "", zoomed = "0"] = output.trim().split(" ");
  return { width: Number(width) || 0, height: Number(height) || 0, zoomed: zoomed === "1" };
}

/**
 * Gives every pane of the workspace window its place and size at once, from a layout string
 * (`layoutString`). The window's panes must be in the order the string was made for.
 */
export async function applyLayout(run: TmuxRunner, layout: string): Promise<void> {
  await run(["select-layout", "-t", WORKSPACE_TARGET, layout]);
}

/** Set on the workspace window while a relayout it asked for has not been taken up yet. */
const RELAYOUT_FLAG = "@relayout";

/**
 * Makes tmux tell dwa when the workspace window's size changes, with `<self> key relayout`. The
 * hook is the window's own, so a pool window never runs it, and it names no pane. While the flag
 * is set no second command is started: dragging a terminal's edge changes the size many times a
 * second (docs/spikes.md, S13). `relayoutTaken` clears the flag.
 */
export async function installResizeHook(run: TmuxRunner, self: string): Promise<void> {
  const ask = `set -w ${RELAYOUT_FLAG} 1 ; run-shell -b ${tmuxQuote(`${self} key relayout`)}`;
  await relayoutTaken(run);
  // A workspace started by an earlier version sized its panes from a hook of the whole server.
  await run(["set-hook", "-gu", "window-resized"]);
  await run([
    "set-hook",
    "-w",
    "-t",
    WORKSPACE_TARGET,
    "window-resized",
    `if-shell -F '#{${RELAYOUT_FLAG}}' '' ${tmuxQuote(ask)}`,
  ]);
}

/** Lets the next change of the window's size ask for a relayout again. */
export async function relayoutTaken(run: TmuxRunner): Promise<void> {
  await run(["set", "-wu", "-t", WORKSPACE_TARGET, RELAYOUT_FLAG]);
}

/** Moves the feed from the pool to the right of the agents pane, leaving the focus where it is. */
export async function showFeed(
  run: TmuxRunner,
  options: { feed: string; right: string },
): Promise<void> {
  await run(["join-pane", "-d", "-h", "-s", options.feed, "-t", options.right]);
}

export async function setTitle(run: TmuxRunner, pane: string, title: string): Promise<void> {
  await run(["select-pane", "-t", pane, "-T", title]);
}

/** Starts an agent in its own background window (the pool) and returns its pane id. */
export async function spawnPoolWindow(
  run: TmuxRunner,
  options: { cwd: string; name: string; command: PaneCommand },
): Promise<string> {
  const pane = await run([
    "new-window",
    "-d",
    "-t",
    `${SESSION}:`,
    "-n",
    options.name,
    "-c",
    options.cwd,
    ...envArgs(options.command.env),
    ...PRINT_PANE,
    "--",
    ...options.command.argv,
  ]);
  await setTitle(run, pane, options.command.title);
  return pane;
}

/**
 * Moves a pane from the pool into the workspace window, right after `after` in the window's pane
 * order, leaving the focus where it is. Its size is the layout's to set.
 */
export async function showPane(
  run: TmuxRunner,
  options: { pane: string; after: string },
): Promise<void> {
  await run(["join-pane", "-d", "-v", "-s", options.pane, "-t", options.after]);
}

/** Zooms the workspace window's active pane, or ends the zoom. */
export async function toggleZoom(run: TmuxRunner): Promise<void> {
  await run(["resize-pane", "-Z", "-t", WORKSPACE_TARGET]);
}

/** Exchanges the places of two panes, leaving the focus where it is. */
export async function swapPanes(run: TmuxRunner, a: string, b: string): Promise<void> {
  await run(["swap-pane", "-d", "-s", a, "-t", b]);
}

/** Sends an open agent's pane back to its own background window. The session keeps running. */
export async function returnToPool(
  run: TmuxRunner,
  options: { agent: string; name: string },
): Promise<void> {
  await run(["break-pane", "-d", "-s", options.agent, "-n", options.name]);
}

export async function focusPane(run: TmuxRunner, pane: string): Promise<void> {
  await run(["select-pane", "-t", pane]);
}

/**
 * Ends what runs in a pane and starts another command in its place. The pane keeps its id,
 * its size and its position, so a restarted session stays where it was.
 */
export async function respawnPane(
  run: TmuxRunner,
  options: { pane: string; cwd: string; command: PaneCommand },
): Promise<void> {
  await run([
    "respawn-pane",
    "-k",
    "-t",
    options.pane,
    "-c",
    options.cwd,
    ...envArgs(options.command.env),
    "--",
    ...options.command.argv,
  ]);
  await setTitle(run, options.pane, options.command.title);
}

export async function killPane(run: TmuxRunner, pane: string): Promise<void> {
  await run(["kill-pane", "-t", pane]);
}

export interface PaneStatus {
  paneId: string;
  dead: boolean;
  /** True when the pane is in the workspace window (visible), false when it is in the pool. */
  inWorkspace: boolean;
  /** True for the pane of its window that has the focus. */
  active: boolean;
}

export function parsePaneList(output: string): PaneStatus[] {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [paneId = "", dead = "0", active = "0", ...window] = line.split(" ");
      return {
        paneId,
        dead: dead === "1",
        active: active === "1",
        inWorkspace: window.join(" ") === WORKSPACE_WINDOW,
      };
    });
}

/** Every pane of the session. Those of one window come in that window's pane order. */
export async function listPanes(run: TmuxRunner): Promise<PaneStatus[]> {
  const output = await run([
    "list-panes",
    "-s",
    "-t",
    `=${SESSION}`,
    "-F",
    "#{pane_id} #{pane_dead} #{pane_active} #{window_name}",
  ]);
  return parsePaneList(output);
}
