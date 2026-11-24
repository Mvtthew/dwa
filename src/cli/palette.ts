// `dwa palette`: a small command menu, shown in a popup with the prefix key and `p`.
// Type a number to run an entry, or text to narrow the list.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentInfo, WorkspaceState } from "../shared/protocol.ts";
import { call } from "./client.ts";

export type PaletteAction =
  | { kind: "open"; target: string }
  | { kind: "close" }
  | { kind: "focus" }
  | { kind: "send"; target: string }
  | { kind: "stop"; target: string }
  | { kind: "spawn"; role?: string }
  | { kind: "answer" }
  | { kind: "down" };

export interface PaletteItem {
  label: string;
  action: PaletteAction;
}

/** Agent definitions available in the project, by file name. */
export function projectRoles(projectRoot: string): string[] {
  const dir = join(projectRoot, ".claude", "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -3))
    .sort();
}

export function paletteItems(state: WorkspaceState, roles: string[]): PaletteItem[] {
  const items: PaletteItem[] = [];
  const open = state.agents.find((agent) => agent.open);
  if (state.questions.length > 0) {
    items.push({
      label: `Answer questions (${state.questions.length} open)`,
      action: { kind: "answer" },
    });
  }
  for (const agent of state.agents) {
    if (!agent.open)
      items.push({ label: `Open ${agent.name}`, action: { kind: "open", target: agent.id } });
  }
  if (open) items.push({ label: `Close ${open.name}`, action: { kind: "close" } });
  items.push({ label: "Focus main", action: { kind: "focus" } });
  const everyone: AgentInfo[] = [...(state.main ? [state.main] : []), ...state.agents];
  for (const agent of everyone) {
    items.push({ label: `Message ${agent.name}`, action: { kind: "send", target: agent.id } });
  }
  items.push({ label: "Start agent", action: { kind: "spawn" } });
  for (const role of roles) {
    items.push({ label: `Start agent as ${role}`, action: { kind: "spawn", role } });
  }
  for (const agent of state.agents) {
    items.push({ label: `Stop ${agent.name}`, action: { kind: "stop", target: agent.id } });
  }
  items.push({ label: "Stop the workspace", action: { kind: "down" } });
  return items;
}

/** Keeps the entries whose label contains every word of the query, in any order. */
export function filterItems(items: PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => words.every((word) => item.label.toLowerCase().includes(word)));
}

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function confirm(question: string): boolean {
  return /^y(es)?$/i.test((prompt(`${question} [y/N]`) ?? "").trim());
}

async function run(projectRoot: string, action: PaletteAction): Promise<void> {
  switch (action.kind) {
    case "open":
      await call(projectRoot, "POST", "/agents/open", { target: action.target });
      return;
    case "close":
      await call(projectRoot, "POST", "/agents/close");
      return;
    case "focus":
      await call(projectRoot, "POST", "/focus");
      return;
    case "send": {
      const body = (prompt("Message:") ?? "").trim();
      if (body) await call(projectRoot, "POST", "/messages", { to: action.target, body });
      return;
    }
    case "stop":
      if (confirm("End this agent's session?")) {
        await call(projectRoot, "POST", "/agents/stop", { target: action.target });
      }
      return;
    case "spawn": {
      const name = (prompt(`Name${action.role ? ` [${action.role}]` : " [agent]"}:`) ?? "").trim();
      const task = (prompt("First task (optional):") ?? "").trim();
      await call(projectRoot, "POST", "/agents", {
        name: name || undefined,
        role: action.role,
        task: task || undefined,
      });
      return;
    }
    case "answer":
      await (await import("./talk.ts")).talkCommand(projectRoot, "answer", []);
      return;
    case "down":
      if (confirm("Stop every session in this workspace?")) {
        await call(projectRoot, "POST", "/down");
      }
      return;
  }
}

export async function paletteCommand(projectRoot: string): Promise<number> {
  const state = await call<WorkspaceState>(projectRoot, "GET", "/state");
  const all = paletteItems(state, projectRoles(projectRoot));
  let shown = all;
  while (true) {
    console.log("\x1b[2J\x1b[H");
    shown.forEach((item, index) => {
      console.log(`${DIM}${String(index + 1).padStart(2)}${RESET}  ${item.label}`);
    });
    if (shown.length === 0) console.log(`${DIM}Nothing matches.${RESET}`);
    const input = (
      prompt(`\n${BOLD}Number, or text to filter${RESET} ${DIM}(empty to close)${RESET}:`) ?? ""
    ).trim();
    if (input === "") return 0;
    const picked = /^\d+$/.test(input) ? shown[Number(input) - 1] : undefined;
    const matches = picked ? [picked] : filterItems(all, input);
    const [only] = matches;
    if (matches.length === 1 && only) {
      try {
        await run(projectRoot, only.action);
      } catch (error) {
        console.error((error as Error).message);
        await Bun.sleep(1500);
      }
      return 0;
    }
    shown = picked ? shown : matches;
  }
}
