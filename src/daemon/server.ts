import { ConfigError } from "../shared/config.ts";
import type { SpawnRequest, UpRequest } from "../shared/protocol.ts";
import { TmuxError } from "../tmux/driver.ts";
import { type Workspace, WorkspaceError } from "./workspace.ts";

export interface ServerOptions {
  socketPath: string;
  workspace: Workspace;
  /** Called after `/down` has answered, to stop the daemon process. */
  onShutdown: () => void;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function body<T>(request: Request): Promise<T> {
  const text = await request.text();
  return (text ? JSON.parse(text) : {}) as T;
}

function requireTarget(input: { target?: unknown }): string {
  if (typeof input.target !== "string" || input.target === "") {
    throw new WorkspaceError("Missing agent name or number.");
  }
  return input.target;
}

/** The daemon's local API on a Unix socket. The CLI and the UI panes are its clients. */
export function startServer(options: ServerOptions) {
  const { workspace } = options;

  const route = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const key = `${request.method} ${pathname}`;
    switch (key) {
      case "GET /ping":
        return json({ ok: true, pid: process.pid });
      case "GET /state":
        return json(await workspace.state());
      case "POST /up":
        return json(await workspace.up(await body<UpRequest>(request)));
      case "POST /agents":
        return json(await workspace.spawn(await body<SpawnRequest>(request)));
      case "POST /agents/open":
        return json(await workspace.open(requireTarget(await body(request))));
      case "POST /agents/close":
        await workspace.close();
        return json({ ok: true });
      case "POST /agents/stop":
        return json(await workspace.stop(requireTarget(await body(request))));
      case "POST /focus":
        await workspace.focusMain();
        return json({ ok: true });
      case "POST /down":
        await workspace.down();
        setTimeout(options.onShutdown, 50);
        return json({ ok: true });
      default:
        return json({ error: `Unknown route: ${key}` }, 404);
    }
  };

  return Bun.serve({
    unix: options.socketPath,
    async fetch(request) {
      try {
        return await route(request);
      } catch (error) {
        const expected =
          error instanceof WorkspaceError ||
          error instanceof ConfigError ||
          error instanceof TmuxError ||
          error instanceof SyntaxError;
        if (!expected) console.error(error);
        return json({ error: (error as Error).message }, expected ? 400 : 500);
      }
    },
  });
}
