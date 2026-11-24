import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanEnv } from "../shared/env.ts";
import { daemonSocketPath, runDir } from "../shared/paths.ts";
import type { ErrorResponse } from "../shared/protocol.ts";

/** The daemon could not be reached at all (as opposed to answering with an error). */
export class DaemonUnreachable extends Error {}

/** Sends one request to the project's daemon and returns the parsed answer. */
export async function call<T>(
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
    await call(projectRoot, "GET", "/ping");
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
  const log = Bun.file(join(dir, "daemon.log"));
  const proc = Bun.spawn([...selfArgv, "daemon"], {
    cwd: projectRoot,
    env: { ...cleanEnv(process.env), DWA_PROJECT: projectRoot },
    stdin: "ignore",
    stdout: log,
    stderr: log,
    detached: true,
  });
  proc.unref();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await isDaemonRunning(projectRoot)) return;
    await Bun.sleep(100);
  }
  throw new Error(`The dwa daemon did not start. See ${join(dir, "daemon.log")}`);
}
