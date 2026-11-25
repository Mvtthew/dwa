// `dwa agent tools`: the tools dialog for the command line.
import { APP_NAME } from "../shared/constants.ts";
import type {
  RestartWhen,
  ToolsInfo,
  ToolsSaveRequest,
  ToolsSaveResult,
} from "../shared/protocol.ts";
import { parseRef } from "../shared/scope.ts";
import type { ToolChange } from "../shared/tools.ts";
import { call } from "./client.ts";

export interface ToolsOptions {
  block: string[];
  unblock: string[];
  scope?: string;
  file?: string;
  when?: RestartWhen;
  json: boolean;
}

/** What a name given to --block or --unblock stands for in this session. */
function changeFor(name: string, on: boolean, info: ToolsInfo): ToolChange {
  const servers = info.view.servers.map((server) => server.name);
  const parts = /^mcp__(.+?)(?:__(.+))?$/.exec(name);
  if (parts?.[2] && servers.includes(parts[1] as string)) {
    return { kind: "server-tool", server: parts[1] as string, name: parts[2], on };
  }
  if (parts && !parts[2]) return { kind: "server", name: parts[1] as string, on };
  if (name.includes("(")) return { kind: "rule", list: "deny", rule: name, on: !on };
  return { kind: "tool", name, on };
}

function show(info: ToolsInfo): void {
  const { agent, view } = info;
  const mark = (on: boolean) => (on ? "[x]" : "[ ]");
  console.log(`${agent.name} (${agent.role ? `role ${agent.role}` : "no role"})`);
  if (info.outOfDate) console.log("Its role changed since it was started.");
  const origin = view.mode === "only" ? view.origins.tools : view.origins.deny_tools;
  console.log(`\nBuilt-in tools${origin ? `  (from ${origin})` : ""}`);
  for (const tool of view.tools) console.log(`  ${mark(tool.on)} ${tool.name}`);
  console.log("\nMCP servers");
  for (const server of view.servers) {
    const note = server.fixed ?? (server.from === "project" ? "from the project" : "");
    console.log(`  ${mark(server.on)} ${server.name}${note ? `  (${note})` : ""}`);
    for (const tool of server.tools ?? []) console.log(`      ${mark(tool.on)} ${tool.name}`);
  }
  if (view.rules.length > 0) {
    console.log("\nRules");
    for (const rule of view.rules) console.log(`  ${rule.list.padEnd(5)} ${rule.rule}`);
  }
}

export async function toolsCommand(
  projectRoot: string,
  target: string | undefined,
  options: ToolsOptions,
): Promise<number> {
  if (!target) {
    console.error(`Usage: ${APP_NAME} agent tools <name|main> [--block <x>] [--unblock <x>]`);
    return 2;
  }
  const info = await call<ToolsInfo>(
    projectRoot,
    "GET",
    `/tools?target=${encodeURIComponent(target)}`,
  );
  const changes = [
    ...options.block.map((name) => changeFor(name, false, info)),
    ...options.unblock.map((name) => changeFor(name, true, info)),
  ];
  if (changes.length === 0) {
    if (options.json) console.log(JSON.stringify(info, null, 2));
    else show(info);
    return 0;
  }
  const scope = options.scope === "role" ? "run" : options.scope === "file" ? "file" : "agent";
  const request: ToolsSaveRequest = {
    target,
    changes,
    scope,
    when: options.when,
    file:
      scope !== "file"
        ? undefined
        : options.file === "defaults"
          ? { kind: "defaults" }
          : options.file === "personal-defaults"
            ? { kind: "defaults", source: "user" }
            : { kind: "role", ...parseRef(options.file ?? info.agent.role ?? "") },
  };
  const result = await call<ToolsSaveResult>(projectRoot, "POST", "/tools", request);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.applied === "ask" ? 1 : 0;
  }
  const { name } = info.agent;
  if (result.applied === "ask") {
    console.error(
      result.reason === "main"
        ? "This restarts the main session. Say when: --when now or --when turn-end."
        : `${name} is working and has to be restarted for this. Say when: --when now or --when turn-end.`,
    );
    return 1;
  }
  if (scope === "file") {
    console.log(
      result.version ? `Saved (v${result.version}).` : (result.note ?? "Nothing changed."),
    );
    if (result.behind.length > 0) {
      const names = result.behind.map((session) => session.name).join(", ");
      console.log(
        `Running with the old setup: ${names}. Bring one up to date with: ${APP_NAME} agent restart <name>`,
      );
    }
  } else {
    const text = {
      live: `${name} has the change now; no restart was needed.`,
      restarted: `${name} was restarted with its conversation and has the change.`,
      pending: `${name} restarts with the change when its turn ends.`,
      unchanged: `Nothing changed for ${name}.`,
    }[result.applied];
    console.log(text);
  }
  if (result.note && scope !== "file") console.log(result.note);
  return 0;
}
