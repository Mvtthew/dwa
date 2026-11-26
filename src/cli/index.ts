#!/usr/bin/env bun
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { APP_NAME } from "../shared/constants.ts";
import { cleanEnv, spawnOrigin } from "../shared/env.ts";
import { findProjectRoot, runDir, tmuxSocketName } from "../shared/paths.ts";
import type { AgentInfo, WorkspaceState } from "../shared/protocol.ts";
import { tmuxArgv } from "../tmux/driver.ts";
import { SESSION } from "../tmux/layout.ts";
import { call, ensureDaemon, isDaemonRunning } from "./client.ts";

const USAGE = `${APP_NAME} ${pkg.version}

Usage: ${APP_NAME}                          Start this project's workspace, or attach to it when it runs
       ${APP_NAME} <command> [options]

Workspace
  init [--roles]                        Create .dwa/config.toml (--roles: example roles, workflow)
  up [--profile <name>] [--no-attach]   The same as running ${APP_NAME} alone; the options work there too
  attach                                Attach to the running workspace
  palette                               Menu of workspace actions (prefix key, then p)
  shell                                 Show or hide a plain shell under the main session
  wizard <workflows|agent|tools|roles|design|menu> [session, role or workflow]
                                        The forms behind the status pane's buttons
  down                                  Stop every session and the workspace

Agents
  agent spawn [name] [--role <role>] [--profile <name>] [--task <text>] [--skill <name>]
              [--model <model>] [--effort <low|medium|high|xhigh|max>]
              [--permission-mode <mode>] [--tools <a,b>] [--deny-tools <a,b>]
              [--allow <rule>]... [--deny <rule>]... [--mcp <a,b>] [--plugins <a,b>]
              [--skills <a,b>] [--off-plugins <a,b>] [--off-skills <a,b>]
              [--builtin-skills <a,b>] [--memory] [--subagents] [--keep]
                                        These replace what the role says, for this agent.
                                        Run inside a session it works like its spawn_agent tool:
                                        it can only take away from the role, and the new agent
                                        reports to that session (--keep: stays open afterwards)
  agent list [--json]
  agent open <name|number>              Show an agent's session under the main session
  agent close                           Hide the open agent (it keeps running)
  agent stop <name|number>              End an agent's session
  agent send <name> <text>              Send a message to an agent
  agent tools <name|main> [--json]      What a session can use: tools, MCP servers, rules
  agent tools <name|main> --block <x>... --unblock <x>... [--scope agent|role|file]
              [--file <role>|defaults|personal-defaults] [--when now|turn-end]
                                        Switch tools, MCP servers (mcp__name) or rules off and on:
                                        for this session, for its role until the workspace stops,
                                        or in a file
  agent restart <name|main> [--when turn-end]
                                        Start a session again with its conversation and the
                                        role as it is now

Roles and configuration
  role list [--json]                    Roles in .dwa/roles and your personal ones
  role show <role> | --main [--json]    What a session of a role is started with, after all layers
  role new | copy | rename | delete     Create and manage role files (see: role)
  role edit-prompt <role>               The role's prompt in $EDITOR
  role edit-when-to-use <role>          What to hand to the role, in $EDITOR
  role history | diff | switch <role>   Numbered versions of a role file, and going back to one
  config check                          Check the config, the roles and what they refer to

Talking to agents
  ask <name> <question>                 Ask an agent and wait for its answer
  answer [id] [text]                    Answer an open question (goes through them when run bare, asks for the text when given only an id)
  inbox                                 Show open questions and messages agents sent to you
  inbox clear                           Take the messages so far out of that list and the status pane

Workflows
  workflow list                         The project's and your personal workflows, and the runs
  workflow new <name> [--from <template>] [--personal]  A new workflow file
  workflow show <name or run>           The steps as a picture; a run shows how far it is
  workflow design [name or run]         Open the workflow designer (also: prefix g)
  workflow duplicate|rename|move|delete <name> ...   Change the files (see: workflow show)
  workflow history|diff|switch <name>   Versions of a workflow file and the way back to one
  workflow run <name> [input]           Start a run; each step gets its own agent
  workflow status [run]                 Steps and results of a run (the latest when run bare)
  workflow cancel <run>                 Stop a run and its agents
  workflow edit <run> [file] [--yes]    Change a run in progress: in $EDITOR, or from a file
  workflow definition <run>             Print the definition a run is working from
  workflow complete <run> <step> <result>  Close a running step by hand
  workflow fail <run> <step> <reason>   Fail a running step by hand

Other
  status     Print the workspace state as JSON
  doctor     Check that bun, tmux and the Claude command(s) are present and new enough,
             and that the configuration is sound (as config check does)
  version    Print the version
  help, ?    Show this help
`;

const selfArgv = [process.execPath, Bun.main];

async function attach(projectRoot: string): Promise<number> {
  if (!process.stdout.isTTY) {
    console.log(`Workspace is running. Attach from a terminal with \`${APP_NAME} attach\`.`);
    return 0;
  }
  const argv = tmuxArgv(
    { socketName: tmuxSocketName(projectRoot), confPath: join(runDir(projectRoot), "tmux.conf") },
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
      model: { type: "string" },
      effort: { type: "string" },
      "permission-mode": { type: "string" },
      tools: { type: "string" },
      "deny-tools": { type: "string" },
      allow: { type: "string", multiple: true },
      deny: { type: "string", multiple: true },
      mcp: { type: "string" },
      plugins: { type: "string" },
      skills: { type: "string" },
      skill: { type: "string" },
      "off-plugins": { type: "string" },
      "off-skills": { type: "string" },
      "builtin-skills": { type: "string" },
      memory: { type: "boolean" },
      subagents: { type: "boolean" },
      keep: { type: "boolean" },
      json: { type: "boolean" },
      block: { type: "string", multiple: true },
      unblock: { type: "string", multiple: true },
      scope: { type: "string" },
      file: { type: "string" },
      when: { type: "string" },
    },
  });
  const [action, target] = positionals;
  const when = values.when === "turn-end" || values.when === "now" ? values.when : undefined;
  // A comma-separated list; an empty value means "none", which is not the same as not given.
  const list = (value: string | undefined) =>
    value?.split(",").flatMap((item) => (item.trim() ? [item.trim()] : []));
  switch (action) {
    case "spawn": {
      const agent = await call<AgentInfo>(projectRoot, "POST", "/agents", {
        name: target,
        role: values.role,
        profile: values.profile,
        model: values.model,
        effort: values.effort,
        task: values.task,
        skill: values.skill,
        permission_mode: values["permission-mode"],
        tools: list(values.tools),
        deny_tools: list(values["deny-tools"]),
        allow: values.allow,
        deny: values.deny,
        mcp: list(values.mcp),
        plugins: list(values.plugins),
        skills: list(values.skills),
        off_plugins: list(values["off-plugins"]),
        off_skills: list(values["off-skills"]),
        builtin_skills: list(values["builtin-skills"]),
        memory: values.memory,
        subagents: values.subagents,
        keep: values.keep,
        // From inside a session this is the same as its spawn_agent tool: narrow only.
        ...spawnOrigin(process.env),
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
    case "send": {
      const [, , ...words] = positionals;
      const sent = await call<{ to: string }>(projectRoot, "POST", "/messages", {
        to: target,
        body: words.join(" "),
      });
      console.log(`Message sent to ${sent.to}.`);
      return 0;
    }
    case "tools":
      return (await import("./tools.ts")).toolsCommand(projectRoot, target, {
        block: values.block ?? [],
        unblock: values.unblock ?? [],
        scope: values.scope,
        file: values.file,
        when,
        json: values.json ?? false,
      });
    case "restart": {
      const { applied } = await call<{ applied: string }>(projectRoot, "POST", "/agents/restart", {
        target,
        when,
      });
      console.log(
        applied === "pending"
          ? `${target} restarts when its turn ends.`
          : `${target} was restarted.`,
      );
      return 0;
    }
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

/**
 * Actions bound to keys in the workspace. tmux shows a failing command's output over the active
 * pane, so these never print or fail: a problem is reported as a short message instead.
 */
async function keyCommand(projectRoot: string, args: string[]): Promise<number> {
  const [action, target] = args;
  try {
    if (action === "open") await call(projectRoot, "POST", "/agents/open", { target });
    else if (action === "close") await call(projectRoot, "POST", "/agents/close");
    else if (action === "focus") await call(projectRoot, "POST", "/focus");
    else if (action === "shell") await call(projectRoot, "POST", "/shell/toggle");
  } catch (error) {
    const message =
      action === "open" && /^No agent/.test((error as Error).message)
        ? `No agent at position ${target}`
        : (error as Error).message;
    await call(projectRoot, "POST", "/notify", { message }).catch(() => undefined);
  }
  return 0;
}

// Heavier commands are imported only when used, so the commands Claude Code runs on every hook
// event and status line refresh start quickly.
async function main(argv: string[]): Promise<number> {
  // Run alone, or with only the options of `up`, the command starts the workspace or attaches
  // to the one that runs: `up` does nothing to a running workspace before it attaches.
  const bare = argv[0] === undefined || argv[0] === "--profile" || argv[0] === "--no-attach";
  const [command, ...rest] = bare ? ["up", ...argv] : argv;
  if (command === "hook") return (await import("./hook.ts")).hookCommand(rest[0]);
  if (command === "statusline") return (await import("./hook.ts")).statuslineCommand();
  if (command === "mailbox") return (await import("./hook.ts")).mailboxCommand();
  if (command === "mcp") {
    await (await import("../mcp/server.ts")).runMcp();
    return new Promise<number>(() => {});
  }
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
      if (await isDaemonRunning(projectRoot)) {
        await call(projectRoot, "POST", "/down");
        // Wait for the daemon to exit, so an `up` right after this starts a fresh one.
        for (let i = 0; i < 50 && (await isDaemonRunning(projectRoot)); i++) await Bun.sleep(50);
      }
      console.log("Workspace stopped.");
      return 0;
    case "ask":
    case "answer":
    case "inbox":
      return (await import("./talk.ts")).talkCommand(projectRoot, command, rest);
    case "workflow":
      if (rest[0] === "design") {
        // Over the workspace when it is running, otherwise in this terminal.
        // A number is a run: its picture, live.
        const run = /^#?(\d+)$/.exec(rest[1] ?? "");
        const subject = run ? `run:${run[1]}` : rest[1];
        const shown = await call(projectRoot, "POST", "/popup", { kind: "design", subject })
          .then(() => true)
          .catch(() => false);
        if (shown) return 0;
        return (await import("../ui/main.ts")).runWizard("design", projectRoot, selfArgv, subject);
      }
      return (await import("./workflow.ts")).workflowCommand(projectRoot, rest);
    case "role":
      return (await import("./roles.ts")).roleCommand(projectRoot, rest);
    case "config":
      return (await import("./roles.ts")).configCommand(projectRoot, rest);
    case "palette":
      return (await import("../ui/main.ts")).runWizard("menu", projectRoot, selfArgv);
    case "init":
      return (await import("./init.ts")).initCommand(projectRoot, rest);
    case "status":
      console.log(JSON.stringify(await call(projectRoot, "GET", "/state"), null, 2));
      return 0;
    case "agent":
      return agentCommand(projectRoot, rest);
    case "focus":
      await call(projectRoot, "POST", "/focus");
      return 0;
    case "key":
      return keyCommand(projectRoot, rest);
    case "shell": {
      const { open } = await call<{ open: boolean }>(projectRoot, "POST", "/shell/toggle");
      console.log(open ? "Shell shown." : "Shell hidden.");
      return 0;
    }
    case "wizard": {
      const kind = rest[0];
      const kinds = [
        "workflows",
        "agent",
        "tools",
        "roles",
        "design",
        "detail",
        "messages",
        "menu",
      ] as const;
      const known = kinds.find((entry) => entry === kind);
      if (!known) {
        console.error(`Usage: ${APP_NAME} wizard <${kinds.join("|")}> [session, role or workflow]`);
        return 2;
      }
      return (await import("../ui/main.ts")).runWizard(known, projectRoot, selfArgv, rest[1]);
    }
    case "ui": {
      const view = rest[0];
      if (view !== "status" && view !== "agents") {
        console.error("Usage: dwa ui <status|agents>");
        return 2;
      }
      return (await import("../ui/main.ts")).runUi(view, projectRoot);
    }
    case "daemon":
      await (await import("../daemon/main.ts")).runDaemon(projectRoot, selfArgv);
      return new Promise<number>(() => {});
    case "doctor":
      return (await import("./doctor.ts")).doctor(projectRoot);
    case "version":
    case "--version":
    case "-v":
      console.log(pkg.version);
      return 0;
    case "help":
    case "?":
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
