import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { cleanEnv } from "../shared/env.ts";
import { daemonSocketPath, runDir, tmuxSocketName } from "../shared/paths.ts";
import type { ErrorResponse } from "../shared/protocol.ts";
import { tmuxArgv } from "../tmux/driver.ts";

/** The daemon could not be reached at all (as opposed to answering with an error). */
export class DaemonUnreachable extends Error {}

/** How this process was started, which is also how it starts the daemon. */
const SELF_ARGV = [process.execPath, Bun.main];

/**
 * Whether the project's workspace is still there without its daemon: the private tmux server
 * holds the sessions, and it outlives a daemon that crashed or was stopped alone.
 */
async function workspaceAlive(projectRoot: string): Promise<boolean> {
  try {
    const argv = tmuxArgv(
      { socketName: tmuxSocketName(projectRoot), confPath: join(runDir(projectRoot), "tmux.conf") },
      ["has-session"],
    );
    const proc = Bun.spawn(argv, {
      env: cleanEnv(process.env),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Sends one request to the project's daemon and returns the parsed answer. When the daemon is
 * gone but the workspace is still running, the daemon is started again first: it finds the
 * sessions as they are. Without a workspace there is nothing to come back to, and the caller
 * is told to run `dwa up`.
 */
export async function call<T>(
  projectRoot: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  try {
    return await request<T>(projectRoot, method, path, body);
  } catch (error) {
    if (!(error instanceof DaemonUnreachable) || !(await workspaceAlive(projectRoot))) throw error;
    await ensureDaemon(projectRoot, SELF_ARGV);
    return request<T>(projectRoot, method, path, body);
  }
}

/** One request, as it is: no attempt to bring a missing daemon back. */
async function request<T>(
  projectRoot: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`http://localhost${path}`, {
      unix: daemonSocketPath(projectRoot),
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new DaemonUnreachable("The dwa daemon is not running for this project. Run `dwa up`.");
  }
  const data = (await response.json()) as T | ErrorResponse;
  if (!response.ok) throw new Error((data as ErrorResponse).error ?? `HTTP ${response.status}`);
  return data as T;
}

export async function isDaemonRunning(projectRoot: string): Promise<boolean> {
  try {
    await request(projectRoot, "GET", "/ping");
    return true;
  } catch {
    return false;
  }
}

/** Starts the daemon in the background unless it is already running. */
export async function ensureDaemon(projectRoot: string, selfArgv: string[]): Promise<void> {
  if (await isDaemonRunning(projectRoot)) return;
  const dir = runDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  // Appended to: a daemon that comes back must not write over what the last one logged.
  const log = openSync(join(dir, "daemon.log"), "a");
  const proc = Bun.spawn([...selfArgv, "daemon"], {
    cwd: projectRoot,
    env: { ...cleanEnv(process.env), DWA_PROJECT: projectRoot },
    stdin: "ignore",
    stdout: log,
    stderr: log,
    detached: true,
  });
  proc.unref();
  closeSync(log);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await isDaemonRunning(projectRoot)) return;
    await Bun.sleep(100);
  }
  throw new Error(`The dwa daemon did not start. See ${join(dir, "daemon.log")}`);
}
