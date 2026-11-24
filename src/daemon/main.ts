import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeProvider } from "../providers/claude/launch.ts";
import { loadConfig } from "../shared/config.ts";
import { cleanEnv } from "../shared/env.ts";
import { daemonSocketPath, runDir, socketDir, tmuxSocketName } from "../shared/paths.ts";
import { buildTmuxConf } from "../tmux/conf.ts";
import { createTmux } from "../tmux/driver.ts";
import { Store } from "./db.ts";
import { startServer } from "./server.ts";
import { Workspace } from "./workspace.ts";

/** Path of the generated tmux config for a project. */
export function tmuxConfPath(projectRoot: string): string {
  return join(runDir(projectRoot), "tmux.conf");
}

/** Runs the daemon for one project until it is told to shut down. */
export async function runDaemon(projectRoot: string, selfArgv: string[]): Promise<void> {
  const run = runDir(projectRoot);
  mkdirSync(run, { recursive: true });
  mkdirSync(socketDir(), { recursive: true });
  chmodSync(socketDir(), 0o700);

  const socketPath = daemonSocketPath(projectRoot);
  rmSync(socketPath, { force: true });

  const confPath = tmuxConfPath(projectRoot);
  writeFileSync(confPath, buildTmuxConf({ selfArgv, projectRoot }));

  const env = cleanEnv(process.env);
  const store = new Store(join(run, "dwa.sqlite"));
  const workspace = new Workspace({
    store,
    run: createTmux({ socketName: tmuxSocketName(projectRoot), confPath, env }),
    provider: claudeProvider,
    projectRoot,
    socketPath,
    selfArgv,
    loadConfig: () => loadConfig(projectRoot, env),
    env,
  });

  const shutdown = () => {
    server.stop(true);
    store.close();
    rmSync(socketPath, { force: true });
    process.exit(0);
  };
  const server = startServer({ socketPath, workspace, onShutdown: shutdown });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log(`dwa daemon for ${projectRoot} listening on ${socketPath} (pid ${process.pid})`);
}
