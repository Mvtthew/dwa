import { createCliRenderer } from "@opentui/core";
import pkg from "../../package.json" with { type: "json" };
import { call } from "../cli/client.ts";
import { projectRoles } from "../cli/palette.ts";
import { loadConfig } from "../shared/config.ts";
import type { WizardKind, WorkspaceState } from "../shared/protocol.ts";
import { capabilityLines, resolveSession, summarizeSession } from "../shared/roles.ts";
import { createAgentsView } from "./agents.ts";
import { roleScreen, rolesScreen } from "./role-screens.ts";
import { diskRoleStore } from "./role-store.ts";
import { createStatusView } from "./status.ts";
import { toolsPickScreen, toolsScreen } from "./tool-screens.ts";
import { createWizard, type Screen } from "./wizard.ts";
import { agentScreen, menuScreen, type WizardApi, workflowsScreen } from "./wizards.ts";

export type UiView = "status" | "agents";

const POLL_MS = 500;

/** How often a pane or a dialog checks that the terminal it was started in is still there. */
const ORPHAN_CHECK_MS = 2000;

/**
 * Ends the process when its terminal is gone: the workspace was stopped or the popup's
 * server went away. The hangup signal is not enough by itself, because the renderer keeps
 * the process alive and reads no end of input; a process whose parent is gone is adopted
 * by process 1, which is what the timer looks for.
 */
function exitWithTerminal(cleanup: () => void): void {
  const leave = () => {
    try {
      cleanup();
    } catch {
      // The terminal is gone; there is nothing left to restore.
    }
    process.exit(0);
  };
  process.on("SIGHUP", leave);
  process.on("SIGTERM", leave);
  process.stdin.on("end", leave);
  process.stdin.on("close", leave);
  const timer = setInterval(() => {
    if (process.ppid === 1) leave();
  }, ORPHAN_CHECK_MS);
  // The check alone must not keep a finished wizard running.
  timer.unref();
}

/** Runs one dashboard pane until its tmux pane is closed. */
export async function runUi(view: UiView, projectRoot: string): Promise<never> {
  const renderer = await createCliRenderer({
    // The pane must survive a stray Ctrl+C; it ends when tmux closes it.
    exitOnCtrlC: false,
    enableMouseMovement: false,
    targetFps: 15,
  });
  exitWithTerminal(() => renderer.destroy());

  const post = (path: string, body?: unknown) => {
    call(projectRoot, "POST", path, body).catch((error: Error) => {
      call(projectRoot, "POST", "/notify", { message: error.message }).catch(() => undefined);
    });
  };

  const pane =
    view === "agents"
      ? createAgentsView(renderer, {
          toggle: (agentId) => post("/agents/toggle", { target: agentId }),
          close: () => post("/agents/close"),
          tools: (agentId) => post("/popup", { kind: "tools", subject: agentId }),
        })
      : createStatusView(renderer, {
          version: pkg.version,
          run: (action) => {
            if (action === "shell") return post("/shell/toggle");
            if (action === "close") return post("/agents/close");
            if (action === "focus") return post("/focus");
            if (action === "zoom") return post("/zoom");
            if (action === "detach") return post("/detach");
            return post("/popup", { kind: action });
          },
        });

  while (true) {
    try {
      pane.update(await call<WorkspaceState>(projectRoot, "GET", "/state"), Date.now());
    } catch (error) {
      pane.showMessage((error as Error).message);
    }
    await Bun.sleep(POLL_MS);
  }
}

/**
 * Runs a wizard in the terminal it was started in (a tmux popup). When the wizard ends with a
 * dwa command, such as editing a run in `$EDITOR`, that command runs here afterwards.
 */
export async function runWizard(
  kind: WizardKind | "menu",
  projectRoot: string,
  selfArgv: string[],
  /** What the wizard is about: the session for the tools dialog, the role for its settings. */
  subject?: string,
): Promise<number> {
  const config = await loadConfig(projectRoot).catch(() => null);
  const described = new Map<string, string>();
  const describe = (role: string): string => {
    if (!config) return "The configuration cannot be read; see `config check`.";
    try {
      const session = resolveSession({ config, role: role || undefined }, { projectRoot });
      return capabilityLines(summarizeSession(session))
        .filter(([label]) => ["tools", "mcp", "plugins", "skills"].includes(label))
        .map(([label, text]) => `${label.padEnd(8)}${text}`)
        .join("\n");
    } catch (error) {
      return (error as Error).message;
    }
  };
  const api: WizardApi = {
    call: (method, path, body) => call(projectRoot, method, path, body),
    roles: projectRoles(projectRoot),
    // Asked again on every repaint of the form, so each role is worked out once.
    describeRole: (role) => {
      const known = described.get(role);
      if (known !== undefined) return known;
      const text = describe(role);
      described.set(role, text);
      return text;
    },
    profiles: Object.keys(config?.profiles ?? {}),
  };
  let first: Screen;
  try {
    const store = () => diskRoleStore(projectRoot, config);
    first =
      kind === "agent"
        ? agentScreen(api)
        : kind === "menu"
          ? await menuScreen(api, store())
          : kind === "tools"
            ? subject
              ? await toolsScreen(api, subject)
              : await toolsPickScreen(api)
            : kind === "roles"
              ? subject
                ? roleScreen(api, store(), subject)
                : rolesScreen(api, store())
              : await workflowsScreen(api);
  } catch (error) {
    console.error((error as Error).message);
    await Bun.sleep(2000);
    return 1;
  }
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    enableMouseMovement: false,
    // The wizard decides which row has the keyboard.
    autoFocus: false,
  });
  exitWithTerminal(() => renderer.destroy());
  const exec = await createWizard(renderer, first);
  renderer.destroy();
  if (!exec) return 0;
  const child = Bun.spawn([...selfArgv, ...exec], {
    env: { ...process.env, DWA_PROJECT: projectRoot },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await child.exited;
  // The popup closes with this process; leave time to read what the command printed.
  prompt("Press Enter to close.");
  return 0;
}
