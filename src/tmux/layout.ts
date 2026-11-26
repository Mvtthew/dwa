import { APP_NAME } from "../shared/constants.ts";
import type { TmuxRunner } from "./driver.ts";

export const SESSION = APP_NAME;
export const WORKSPACE_WINDOW = "workspace";
export interface LayoutSizes {
  /** Columns of the status pane on the left. */
  statusWidth: number;
  /** Columns of the agents pane on the right. */
  agentsWidth: number;
  /** Columns of the event feed, right of the agents pane when it is shown. */
  feedWidth: number;
  /** Percent of the centre column given to the agent pane opened under main. */
  agentHeight: number;
}

/** Rows of the top bar's text. tmux draws its border line above it. */
export const TOP_BAR_HEIGHT = 1;

export const DEFAULT_LAYOUT: LayoutSizes = {
  statusWidth: 30,
  agentsWidth: 34,
  feedWidth: 40,
  agentHeight: 40,
};

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

/** The panes whose size the layout keeps: the bar, the side columns, the feed while shown. */
export type FramePanes = Omit<WorkspacePanes, "main">;

/**
 * Creates the session with the top bar across the whole width and three columns under it:
 * status pane, main session, agents pane. The bar keeps its height and the side columns their
 * width when the terminal is resized.
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
    sizes?: LayoutSizes;
  },
): Promise<WorkspacePanes> {
  const { cwd } = options;
  const sizes = options.sizes ?? DEFAULT_LAYOUT;
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
        "-l",
        String(sizes.feedWidth),
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
  const frame: FramePanes = { top, left, right, feed };
  await fixFrame(run, frame, sizes);
  return { top, left, main, right, feed };
}

/** The resizes that put the top bar, the side columns and the feed back to their sizes. */
export function frameResizes(panes: FramePanes, sizes: LayoutSizes = DEFAULT_LAYOUT): string[][] {
  // The feed first: when the terminal is too narrow for everything, the panes sized last keep
  // their widths, and the agents pane matters more than the feed.
  return [
    ["resize-pane", "-t", panes.top, "-y", String(TOP_BAR_HEIGHT)],
    ...(panes.feed ? [["resize-pane", "-t", panes.feed, "-x", String(sizes.feedWidth)]] : []),
    ["resize-pane", "-t", panes.left, "-x", String(sizes.statusWidth)],
    ["resize-pane", "-t", panes.right, "-x", String(sizes.agentsWidth)],
  ];
}

/**
 * Puts the frame back to its sizes now, and makes tmux do the same whenever the terminal is
 * resized. Called again when the feed is shown or hidden, since the hook names its panes.
 */
export async function fixFrame(
  run: TmuxRunner,
  panes: FramePanes,
  sizes: LayoutSizes = DEFAULT_LAYOUT,
): Promise<void> {
  const resizes = frameResizes(panes, sizes);
  for (const args of resizes) await run(args);
  await run([
    "set-hook",
    "-g",
    "window-resized",
    resizes.map((args) => args.join(" ")).join(" ; "),
  ]);
}

/** Moves the feed from the pool to the right of the agents pane, leaving the focus where it is. */
export async function showFeed(
  run: TmuxRunner,
  options: { feed: string; right: string; width: number },
): Promise<void> {
  await run([
    "join-pane",
    "-d",
    "-h",
    "-l",
    String(options.width),
    "-s",
    options.feed,
    "-t",
    options.right,
  ]);
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

/** Moves an agent's pane from the pool to the slot under the main session and focuses it. */
export async function openUnderMain(
  run: TmuxRunner,
  options: { main: string; agent: string; heightPercent?: number },
): Promise<void> {
  const height = `${options.heightPercent ?? DEFAULT_LAYOUT.agentHeight}%`;
  await run(["join-pane", "-v", "-l", height, "-s", options.agent, "-t", options.main]);
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
}

export function parsePaneList(output: string): PaneStatus[] {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [paneId = "", dead = "0", ...window] = line.split(" ");
      return { paneId, dead: dead === "1", inWorkspace: window.join(" ") === WORKSPACE_WINDOW };
    });
}

export async function listPanes(run: TmuxRunner): Promise<PaneStatus[]> {
  const output = await run([
    "list-panes",
    "-s",
    "-t",
    `=${SESSION}`,
    "-F",
    "#{pane_id} #{pane_dead} #{window_name}",
  ]);
  return parsePaneList(output);
}
