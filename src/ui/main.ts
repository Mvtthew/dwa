import { createCliRenderer } from "@opentui/core";
import { call } from "../cli/client.ts";
import type { WorkspaceState } from "../shared/protocol.ts";
import { createAgentsView } from "./agents.ts";
import { createStatusView } from "./status.ts";

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
          open: (agentId) => post("/agents/open", { target: agentId }),
          close: () => post("/agents/close"),
        })
      : createStatusView(renderer);

  while (true) {
    try {
      pane.update(await call<WorkspaceState>(projectRoot, "GET", "/state"), Date.now());
    } catch (error) {
      pane.showMessage((error as Error).message);
    }
    await Bun.sleep(POLL_MS);
  }
}
