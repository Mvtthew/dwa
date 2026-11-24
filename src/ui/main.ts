import { createCliRenderer } from "@opentui/core";
import pkg from "../../package.json" with { type: "json" };
import { call } from "../cli/client.ts";
import { projectRoles } from "../cli/palette.ts";
import { loadConfig } from "../shared/config.ts";
import type { WizardKind, WorkspaceState } from "../shared/protocol.ts";
import { createAgentsView } from "./agents.ts";
import { createStatusView } from "./status.ts";
import { createWizard, type Screen } from "./wizard.ts";
import { agentScreen, menuScreen, type WizardApi, workflowsScreen } from "./wizards.ts";

export type UiView = "status" | "agents";

const POLL_MS = 500;

/** Runs one dashboard pane until its tmux pane is closed. */
export async function runUi(view: UiView, projectRoot: string): Promise<never> {
  const renderer = await createCliRenderer({
    // The pane must survive a stray Ctrl+C; it ends when tmux closes it.
    exitOnCtrlC: false,
    enableMouseMovement: false,
    targetFps: 15,
  });

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
): Promise<number> {
  const config = await loadConfig(projectRoot).catch(() => null);
  const api: WizardApi = {
    call: (method, path, body) => call(projectRoot, method, path, body),
    roles: projectRoles(projectRoot),
    profiles: Object.keys(config?.profiles ?? {}),
  };
  let first: Screen;
  try {
    first =
      kind === "agent"
        ? agentScreen(api)
        : kind === "menu"
          ? await menuScreen(api)
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
