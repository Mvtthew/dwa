import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CliRenderer, createCliRenderer } from "@opentui/core";
import pkg from "../../package.json" with { type: "json" };
import { call } from "../cli/client.ts";
import { openEditor } from "../cli/editor.ts";
import { projectRoles } from "../cli/palette.ts";
import { loadConfig } from "../shared/config.ts";
import { runDir } from "../shared/paths.ts";
import type { WizardKind, WorkspaceState } from "../shared/protocol.ts";
import { capabilityLines, resolveSession, summarizeSession } from "../shared/roles.ts";
import { parseRef } from "../shared/scope.ts";
import { createAgentsView } from "./agents.ts";
import { createDesigner } from "./designer.ts";
import { roleScreen, rolesScreen } from "./role-screens.ts";
import { diskRoleStore } from "./role-store.ts";
import { openRun } from "./run-screens.ts";
import { createStatusView } from "./status.ts";
import { toolsPickScreen, toolsScreen } from "./tool-screens.ts";
import { createWizard, type Outcome, type Screen } from "./wizard.ts";
import { agentScreen, menuScreen, type WizardApi, workflowsScreen } from "./wizards.ts";
import { type DesignDeps, designListScreen, openDesign } from "./workflow-screens.ts";
import { diskWorkflowStore } from "./workflow-store.ts";

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
  // The designer suspends the screen for the user's editor, so it needs the renderer, which
  // exists only once the first screen could be built.
  let screen: CliRenderer | null = null;
  const design: DesignDeps = {
    api,
    store: diskWorkflowStore(projectRoot, config),
    start: (session, live) =>
      createDesigner(
        {
          ...design,
          editText: async (text, label) => {
            if (!screen) return null;
            mkdirSync(runDir(projectRoot), { recursive: true });
            const path = join(runDir(projectRoot), label);
            writeFileSync(path, text);
            await screen.suspend();
            try {
              return (await openEditor(path)) ? readFileSync(path, "utf8") : null;
            } finally {
              await screen.resume();
            }
          },
        },
        session,
        live,
      ).view,
    // Closing the designer goes back to the list the popup is for.
    home: () => (kind === "workflows" ? workflowsScreen(api, design) : designListScreen(design)),
  };
  let first: Screen;
  let then: Outcome | undefined;
  try {
    const store = () => diskRoleStore(projectRoot, config);
    if (kind === "design") {
      first = designListScreen(design);
      const run = /^run:(\d+)$/.exec(subject ?? "");
      if (run) {
        then = await openRun(design, Number(run[1]));
      } else if (subject) {
        // One workflow straight away; the list is what closing the designer returns to.
        const named = parseRef(subject);
        const found = design.store
          .list()
          .find(
            (entry) =>
              entry.name === named.name &&
              (named.source ? entry.source === named.source : !entry.hidden),
          );
        if (!found) throw new Error(`Unknown workflow "${subject}".`);
        then = openDesign(design, { kind: "file", name: found.name, source: found.source });
      }
    } else {
      first =
        kind === "agent"
          ? agentScreen(api)
          : kind === "menu"
            ? await menuScreen(api, store(), design)
            : kind === "tools"
              ? subject
                ? await toolsScreen(api, subject)
                : await toolsPickScreen(api)
              : kind === "roles"
                ? subject
                  ? roleScreen(api, store(), parseRef(subject))
                  : rolesScreen(api, store())
                : await workflowsScreen(api, design);
    }
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
  screen = renderer;
  const exec = await createWizard(renderer, first, then);
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
