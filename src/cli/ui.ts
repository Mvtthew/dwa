import { MAX_VISIBLE_AGENTS } from "../shared/constants.ts";
import type { WorkspaceState } from "../shared/protocol.ts";
import { call } from "./client.ts";

// Plain-text panes for milestone M1. They are replaced by OpenTUI views in M2, which add live
// agent state, scrolling and mouse selection.

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export type UiView = "status" | "agents";

export function renderAgents(state: WorkspaceState): string[] {
  const { agents } = state;
  const shown = agents.slice(0, MAX_VISIBLE_AGENTS);
  const count =
    agents.length > shown.length ? `1–${shown.length} of ${agents.length}` : `${agents.length}`;
  const lines = [`${BOLD}AGENTS ${count}${RESET}`, ""];
  if (agents.length === 0) {
    lines.push(`${DIM}No agents running.${RESET}`, `${DIM}dwa agent spawn <name>${RESET}`);
    return lines;
  }
  shown.forEach((agent, index) => {
    const marker = agent.open ? "▸" : " ";
    const role = agent.role && agent.role !== agent.name ? ` ${DIM}${agent.role}${RESET}` : "";
    lines.push(`${marker} ${index + 1} ${agent.name}${role}`);
  });
  return lines;
}

export function renderStatus(state: WorkspaceState): string[] {
  const lines = [`${BOLD}STATUS${RESET}`, ""];
  lines.push(`main  ${state.main ? state.main.profile : "not running"}`);
  lines.push(`agents ${state.agents.length}`);
  lines.push("", `${BOLD}KEYS${RESET}`, "");
  lines.push("Alt+1..9  open agent", "Alt+x     close agent", "Alt+0     focus main");
  lines.push("Alt+z     zoom pane");
  return lines;
}

/** Redraws a pane once a second from the daemon's state. Runs until the pane is closed. */
export async function runUi(view: UiView, projectRoot: string): Promise<never> {
  process.stdout.write("\x1b[?25l");
  let previous = "";
  while (true) {
    let lines: string[];
    try {
      const state = await call<WorkspaceState>(projectRoot, "GET", "/state");
      lines = view === "agents" ? renderAgents(state) : renderStatus(state);
    } catch (error) {
      lines = [`${DIM}${(error as Error).message}${RESET}`];
    }
    const frame = lines.join("\n");
    if (frame !== previous) {
      process.stdout.write(`\x1b[2J\x1b[H${frame}`);
      previous = frame;
    }
    await Bun.sleep(1000);
  }
}
