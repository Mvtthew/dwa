import { APP_NAME } from "../shared/constants.ts";
import type { TmuxRunner } from "./driver.ts";

export const SESSION = APP_NAME;
export const WORKSPACE_WINDOW = "workspace";
export interface LayoutSizes {
  /** Columns of the status pane on the left. */
  statusWidth: number;
  /** Columns of the agents pane on the right. */
  agentsWidth: number;
  /** Percent of the centre column given to the agent pane opened under main. */
  agentHeight: number;
}

export const DEFAULT_LAYOUT: LayoutSizes = { statusWidth: 30, agentsWidth: 34, agentHeight: 40 };

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
  left: string;
  main: string;
  right: string;
}

/**
 * Creates the session with its three columns: status pane, main session, agents pane.
 * The side columns keep a fixed width when the terminal is resized.
 */
export async function createWorkspace(
  run: TmuxRunner,
  options: {
    cwd: string;
    left: PaneCommand;
    main: PaneCommand;
    right: PaneCommand;
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
  await setTitle(run, left, options.left.title);
  await setTitle(run, main, options.main.title);
  await setTitle(run, right, options.right.title);
  await fixSideColumns(run, { left, right }, sizes);
  await run([
    "set-hook",
    "-g",
    "window-resized",
    `resize-pane -t ${left} -x ${sizes.statusWidth} ; resize-pane -t ${right} -x ${sizes.agentsWidth}`,
  ]);
  return { left, main, right };
}

export async function fixSideColumns(
  run: TmuxRunner,
  panes: { left: string; right: string },
  sizes: LayoutSizes = DEFAULT_LAYOUT,
): Promise<void> {
  await run(["resize-pane", "-t", panes.left, "-x", String(sizes.statusWidth)]);
  await run(["resize-pane", "-t", panes.right, "-x", String(sizes.agentsWidth)]);
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
