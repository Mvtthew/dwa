#!/usr/bin/env bun
import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { runDaemon, tmuxConfPath } from "../daemon/main.ts";
import { APP_NAME } from "../shared/constants.ts";
import { cleanEnv } from "../shared/env.ts";
import { findProjectRoot, tmuxSocketName } from "../shared/paths.ts";
import type { AgentInfo, WorkspaceState } from "../shared/protocol.ts";
import { tmuxArgv } from "../tmux/driver.ts";
import { SESSION } from "../tmux/layout.ts";
import { call, ensureDaemon, isDaemonRunning } from "./client.ts";
import { doctor } from "./doctor.ts";
import { runUi } from "./ui.ts";

const USAGE = `${APP_NAME} ${pkg.version}

Usage: ${APP_NAME} <command> [options]

Workspace
  up [--profile <name>] [--no-attach]   Start the workspace for this project and attach to it
  attach                                Attach to the running workspace
  down                                  Stop every session and the workspace

Agents
  agent spawn [name] [--role <role>] [--profile <name>] [--task <text>]
  agent list [--json]
  agent open <name|number>              Show an agent's session under the main session
  agent close                           Hide the open agent (it keeps running)
  agent stop <name|number>              End an agent's session

Other
  doctor     Check that bun, tmux and the Claude command(s) are present and new enough
  version    Print the version
  help       Show this help
`;

const selfArgv = [process.execPath, Bun.main];

async function attach(projectRoot: string): Promise<number> {
  if (!process.stdout.isTTY) {
    console.log(`Workspace is running. Attach from a terminal with \`${APP_NAME} attach\`.`);
    return 0;
  }
  const argv = tmuxArgv(
    { socketName: tmuxSocketName(projectRoot), confPath: tmuxConfPath(projectRoot) },
    ["attach-session", "-t", `=${SESSION}`],
  );
  const proc = Bun.spawn(argv, {
    env: cleanEnv(process.env),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

function printAgents(agents: AgentInfo[]): void {
  if (agents.length === 0) {
    console.log("No agents running.");
    return;
  }
  agents.forEach((agent, index) => {
    const parts = [`${index + 1}`, agent.name, agent.role ?? "-", agent.profile];
    if (agent.open) parts.push("(open)");
    console.log(parts.join("\t"));
  });
}

async function agentCommand(projectRoot: string, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      role: { type: "string" },
      profile: { type: "string" },
      task: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const [action, target] = positionals;
  switch (action) {
    case "spawn": {
      const agent = await call<AgentInfo>(projectRoot, "POST", "/agents", {
        name: target,
        role: values.role,
        profile: values.profile,
        task: values.task,
      });
      console.log(`Started agent ${agent.name} (profile ${agent.profile}).`);
      return 0;
    }
    case "list":
    case undefined: {
      const state = await call<WorkspaceState>(projectRoot, "GET", "/state");
      if (values.json) console.log(JSON.stringify(state.agents, null, 2));
      else printAgents(state.agents);
      return 0;
    }
    case "open":
      await call(projectRoot, "POST", "/agents/open", { target });
      return 0;
    case "close":
      await call(projectRoot, "POST", "/agents/close");
      return 0;
    case "stop": {
      const agent = await call<AgentInfo>(projectRoot, "POST", "/agents/stop", { target });
      console.log(`Stopped agent ${agent.name}.`);
      return 0;
    }
    default:
      console.error(`Unknown agent command: ${action}\n\n${USAGE}`);
      return 2;
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const projectRoot = findProjectRoot();
  switch (command) {
    case "up": {
      const { values } = parseArgs({
        args: rest,
        options: { profile: { type: "string" }, "no-attach": { type: "boolean" } },
      });
      await ensureDaemon(projectRoot, selfArgv);
      await call(projectRoot, "POST", "/up", { profile: values.profile });
      return values["no-attach"] ? 0 : attach(projectRoot);
    }
    case "attach": {
      const state = await call<WorkspaceState>(projectRoot, "GET", "/state");
      if (!state.up) {
        console.error(`The workspace is not running. Start it with \`${APP_NAME} up\`.`);
        return 1;
      }
      return attach(projectRoot);
    }
    case "down":
      if (await isDaemonRunning(projectRoot)) await call(projectRoot, "POST", "/down");
      console.log("Workspace stopped.");
      return 0;
    case "agent":
      return agentCommand(projectRoot, rest);
    case "focus":
      await call(projectRoot, "POST", "/focus");
      return 0;
    case "ui": {
      const view = rest[0];
      if (view !== "status" && view !== "agents") {
        console.error("Usage: dwa ui <status|agents>");
        return 2;
      }
      return runUi(view, projectRoot);
    }
    case "daemon":
      await runDaemon(projectRoot, selfArgv);
      return new Promise<number>(() => {});
    case "doctor":
      return doctor(projectRoot);
    case "version":
    case "--version":
    case "-v":
      console.log(pkg.version);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      return 2;
  }
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (error) {
  console.error(`${APP_NAME}: ${(error as Error).message}`);
  process.exit(1);
}
