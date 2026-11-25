import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeProvider } from "../providers/claude/launch.ts";
import { loadConfig } from "../shared/config.ts";
import { cleanEnv } from "../shared/env.ts";
import { daemonSocketPath, runDir, socketDir, tmuxSocketName } from "../shared/paths.ts";
import { buildTmuxConf } from "../tmux/conf.ts";
import { createTmux } from "../tmux/driver.ts";
import { Store } from "./db.ts";
import { RoleAuthor } from "./role-author.ts";
import { startServer } from "./server.ts";
import { Workflows } from "./workflows.ts";
import { Workspace } from "./workspace.ts";

async function answers(socketPath: string): Promise<boolean> {
  try {
    const response = await fetch("http://localhost/ping", {
      unix: socketPath,
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes this process the project's one daemon. The lock file is created exclusively and
 * holds the owner's pid. A lock whose owner is gone, or is some other program that got the
 * same pid and so never answers on the socket, is taken over.
 */
export async function takeLock(lockPath: string, socketPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      // Someone holds it; see whether they are a daemon that is running or just starting.
    }
    let owner = Number.NaN;
    try {
      owner = Number(readFileSync(lockPath, "utf8"));
    } catch {
      continue;
    }
    if (Number.isInteger(owner) && owner !== process.pid && alive(owner)) {
      for (let wait = 0; wait < 20; wait++) {
        if (await answers(socketPath)) return false;
        if (!alive(owner)) break;
        await Bun.sleep(100);
      }
    }
    rmSync(lockPath, { force: true });
  }
  return false;
}

/** Runs the daemon for one project until it is told to shut down. */
export async function runDaemon(projectRoot: string, selfArgv: string[]): Promise<void> {
  const run = runDir(projectRoot);
  mkdirSync(run, { recursive: true });
  mkdirSync(socketDir(), { recursive: true });
  chmodSync(socketDir(), 0o700);

  const socketPath = daemonSocketPath(projectRoot);
  // Several commands may find the daemon gone at the same moment and each start one. Only
  // the first may take the socket; the others leave without touching it.
  const lockPath = join(run, "daemon.lock");
  if (!(await takeLock(lockPath, socketPath))) {
    console.log(`another dwa daemon is running for ${projectRoot}; this one exits`);
    process.exit(0);
  }
  rmSync(socketPath, { force: true });

  const env = cleanEnv(process.env);
  const config = await loadConfig(projectRoot, env);
  const confPath = join(run, "tmux.conf");
  writeFileSync(confPath, buildTmuxConf({ selfArgv, projectRoot, prefix: config.keys.prefix }));

  const store = new Store(join(run, "dwa.sqlite"));
  const workspace = new Workspace({
    store,
    run: createTmux({ socketName: tmuxSocketName(projectRoot), confPath, env }),
    provider: claudeProvider,
    projectRoot,
    socketPath,
    selfArgv,
    runDir: run,
    keyPrefix: config.keys.prefix,
    loadConfig: () => loadConfig(projectRoot, env),
    env,
  });

  const workflows = new Workflows({ store, workspace, projectRoot });
  const roleAuthor = new RoleAuthor({
    store,
    workspace,
    loadConfig: () => loadConfig(projectRoot, env),
    env,
  });

  const shutdown = () => {
    server.stop(true);
    store.close();
    rmSync(socketPath, { force: true });
    rmSync(lockPath, { force: true });
    process.exit(0);
  };
  const server = startServer({
    socketPath,
    workspace,
    workflows,
    roleAuthor,
    onShutdown: shutdown,
  });
  // Runs that were in progress when the daemon last stopped carry on.
  workflows.resume().catch((error) => console.error("could not resume workflows:", error));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log(`dwa daemon for ${projectRoot} listening on ${socketPath} (pid ${process.pid})`);
}
