// `dwa role` and `dwa config check`: what the roles are, what a session of each ends up with,
// and whether everything the configuration refers to exists. They read files only; the
// workspace does not have to be running.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { claudeProvider } from "../providers/claude/launch.ts";
import { ConfigError } from "../shared/capabilities.ts";
import { type Config, loadConfig, resolveProfile } from "../shared/config.ts";
import { APP_NAME } from "../shared/constants.ts";
import { diffLines, formatTime, readHistory, switchTo, versionText } from "../shared/history.ts";
import { runDir } from "../shared/paths.ts";
import type { WorkspaceState } from "../shared/protocol.ts";
import {
  createRole,
  deleteRole,
  duplicateRole,
  noticeEdits,
  renameRole,
  roleHistory,
  roleTemplate,
  saveValues,
} from "../shared/role-edit.ts";
import {
  capabilityLines,
  checkSessions,
  findRole,
  listRoles,
  parseRole,
  type ResolvedSession,
  type RoleContext,
  resolveSession,
  summarizeSession,
} from "../shared/roles.ts";
import { listWorkflows, loadWorkflow } from "../shared/workflow.ts";
import { call } from "./client.ts";
import { openEditor } from "./editor.ts";

const ROLE_USAGE = `Usage:
  ${APP_NAME} role list [--json]            Roles of this project and your personal ones
  ${APP_NAME} role show <role> [--json]     What a session of this role is started with
  ${APP_NAME} role show --main [--json]     The same for the main session
  ${APP_NAME} role new <name> [--description <text>] [--personal]
  ${APP_NAME} role copy <role> <new name>
  ${APP_NAME} role rename <role> <new name> Also changes every file that names the role
  ${APP_NAME} role delete <role>            Refused while something uses the role
  ${APP_NAME} role edit-prompt <role>       The role's prompt in $EDITOR
  ${APP_NAME} role history <role> [--json]  Versions of the role file
  ${APP_NAME} role diff <role> [vA] [vB]    What changed (the current version against the one before)
  ${APP_NAME} role switch <role> <vN>       Give the file the content of that version`;

/** "v3" or "3" as a number. */
function versionNumber(text: string | undefined): number | undefined {
  const match = /^v?(\d+)$/.exec(text ?? "");
  return match ? Number(match[1]) : undefined;
}

/** The commands that change role files or look at their history. Null when it is none of them. */
async function roleFileCommand(
  action: string | undefined,
  words: string[],
  values: { json?: boolean; personal?: boolean; description?: string },
  ctx: RoleContext,
): Promise<number | null> {
  const [name, second, third] = words;
  if (action === "new" && name) {
    const entry = createRole(name, roleTemplate(values.description ?? ""), "role new", ctx, {
      personal: values.personal,
    });
    console.log(`Created ${entry.path}`);
    return 0;
  }
  if (action === "copy" && name && second) {
    console.log(`Created ${duplicateRole(name, second, ctx).path}`);
    return 0;
  }
  if ((action === "rename" || action === "delete") && name) {
    // A running session is started again by its role's name, so that name has to stay.
    const state = await call<WorkspaceState>(ctx.projectRoot, "GET", "/state").catch(() => null);
    const running = [...(state?.main ? [state.main] : []), ...(state?.agents ?? [])]
      .filter((agent) => agent.role === name)
      .map((agent) => agent.name);
    if (running.length > 0) {
      console.error(`Stop the running sessions of role ${name} first: ${running.join(", ")}.`);
      return 1;
    }
  }
  if (action === "rename" && name && second) {
    console.log(`Renamed to ${renameRole(name, second, ctx).path}`);
    return 0;
  }
  if (action === "delete" && name) {
    deleteRole(name, ctx);
    console.log(`Deleted role ${name}. Its history is kept.`);
    return 0;
  }
  if (action === "edit-prompt" && name) {
    const loaded = findRole(name, ctx);
    if (!loaded) throw new ConfigError(`Unknown role "${name}".`);
    mkdirSync(runDir(ctx.projectRoot), { recursive: true });
    const path = join(runDir(ctx.projectRoot), `role-${name}-prompt.md`);
    const before = loaded.role.prompt ?? "";
    writeFileSync(path, before);
    if (!(await openEditor(path))) {
      console.error("The editor did not exit cleanly; nothing was changed.");
      return 1;
    }
    const after = readFileSync(path, "utf8");
    if (after === before) {
      console.log("No changes.");
      return 0;
    }
    // A prompt always ends its last line, so the closing quotes stand on their own.
    const prompt = after === "" || after.endsWith("\n") ? after : `${after}\n`;
    const version = saveValues({ kind: "role", name }, { prompt }, "prompt edited", ctx);
    console.log(`Saved the prompt of role ${name} (v${version.n}).`);
    return 0;
  }
  if (action === "history" && name) {
    const history = readHistory(roleHistory(name, ctx));
    if (values.json) {
      console.log(JSON.stringify(history, null, 2));
      return 0;
    }
    for (const version of [...history.versions].reverse()) {
      const mark = version.n === history.current ? "*" : " ";
      console.log(
        `${mark} v${String(version.n).padEnd(4)}${formatTime(version.time)}  ${version.source}`,
      );
    }
    return 0;
  }
  if (action === "diff" && name) {
    const tracked = roleHistory(name, ctx);
    const history = readHistory(tracked);
    const to = versionNumber(third) ?? (third ? undefined : (history.current ?? undefined));
    const numbers = history.versions.map((version) => version.n).filter((n) => n < (to ?? 0));
    const from = second ? versionNumber(second) : numbers.at(-1);
    if (to === undefined || (second && from === undefined)) {
      console.error(ROLE_USAGE);
      return 1;
    }
    if (from === undefined) {
      console.log(`v${to} is the first version; there is nothing to compare it with.`);
      return 0;
    }
    const lines = diffLines(versionText(tracked, from), versionText(tracked, to));
    console.log(`v${from} → v${to}`);
    console.log(lines.length > 0 ? lines.join("\n") : "No differences.");
    return 0;
  }
  if (action === "switch" && name) {
    const n = versionNumber(second);
    if (n === undefined) {
      console.error(ROLE_USAGE);
      return 1;
    }
    const tracked = roleHistory(name, ctx);
    const text = versionText(tracked, n);
    parseRole(text, `v${n}`);
    switchTo(tracked, n);
    console.log(`Role ${name} is now at v${n}. Running sessions keep what they were started with.`);
    return 0;
  }
  return null;
}

/** The command line a session of this kind is started with, without the long prompt texts. */
export function launchPreview(config: Config, session: ResolvedSession): string[] {
  const launch = claudeProvider.buildLaunch({
    profile: resolveProfile(config),
    sessionId: "<session-id>",
    name: session.role ?? "agent",
    session,
    settingsPath: "<settings.json>",
    mcpConfigPath: "<mcp.json>",
    systemPromptPath: "<prompt.md>",
    skillPluginPath: session.skills?.some((skill) => skill.source !== "project")
      ? "<skills plugin>"
      : undefined,
  });
  return launch.argv;
}

function showSession(title: string, config: Config, session: ResolvedSession): void {
  console.log(title);
  const lines = capabilityLines(summarizeSession(session));
  // The summary names skills only; where each comes from matters when reading a role.
  const skills = session.skills
    ?.map(
      (skill) =>
        `${skill.name} (${skill.source === "project" ? ".claude/skills" : skill.source === "dwa" ? `.${APP_NAME}/skills` : "personal"})`,
    )
    .join(", ");
  for (const [label, text] of lines) {
    console.log(`  ${label.padEnd(12)}${label === "skills" && skills ? skills : text}`);
  }
  if (session.hiddenSkills.length > 0) {
    console.log(
      `  ${"hidden".padEnd(12)}${session.hiddenSkills.join(", ")} (project skills not listed)`,
    );
  }
  const off = [...session.offPlugins, ...session.offSkills];
  if (off.length > 0) console.log(`  ${"built-ins".padEnd(12)}off: ${off.join(", ")}`);
  const promptLines = session.prompt?.trim().split("\n").length ?? 0;
  console.log(`  ${"prompt".padEnd(12)}${promptLines > 0 ? `${promptLines} lines` : "none"}`);
  console.log(`\n  ${launchPreview(config, session).join(" ")}`);
}

export async function roleCommand(projectRoot: string, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      main: { type: "boolean" },
      personal: { type: "boolean" },
      description: { type: "string" },
    },
  });
  const [action, name] = positionals;
  const ctx: RoleContext = { projectRoot };
  // Whatever was changed in an editor since the last look gets its version first.
  noticeEdits(ctx);
  try {
    const done = await roleFileCommand(action, positionals.slice(1), values, ctx);
    if (done !== null) return done;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  if (action === "list") {
    const roles = listRoles(ctx).map((entry) => {
      try {
        const role = findRole(entry.name, ctx)?.role;
        return {
          ...entry,
          description: role?.description ?? null,
          extends: role?.extends ?? null,
          error: null,
        };
      } catch (error) {
        return { ...entry, description: null, extends: null, error: (error as Error).message };
      }
    });
    if (values.json) {
      console.log(JSON.stringify(roles, null, 2));
      return 0;
    }
    if (roles.length === 0) {
      console.log(`No roles. Add example roles with: ${APP_NAME} init --roles`);
      return 0;
    }
    const width = Math.max(...roles.map((role) => role.name.length));
    for (const role of roles) {
      const where = role.source === "user" ? " (personal)" : "";
      const text = role.error ? `BROKEN: ${role.error}` : (role.description ?? "");
      console.log(`${role.name.padEnd(width)}  ${text}${where}`);
    }
    return 0;
  }

  if (action === "show" && (name || values.main)) {
    const config = await loadConfig(projectRoot);
    const session = values.main
      ? resolveSession({ config, main: true }, ctx)
      : resolveSession({ config, role: name }, ctx);
    if (values.json) {
      console.log(JSON.stringify(session, null, 2));
      return 0;
    }
    const loaded = session.role ? findRole(session.role, ctx) : null;
    const file = loaded ? relative(projectRoot, loaded.path) : "no role file, defaults only";
    const parent = loaded?.role.extends ? `, extends ${loaded.role.extends}` : "";
    const title = values.main ? `main session: ${session.role ?? "no role"}` : (session.role ?? "");
    showSession(`${title} (${file}${parent})`, config, session);
    return 0;
  }

  console.error(ROLE_USAGE);
  return 1;
}

/** Problems with the workflow files: one that does not parse, or a step with an unknown role. */
function checkWorkflows(projectRoot: string, ctx: RoleContext): string[] {
  const problems: string[] = [];
  for (const workflow of listWorkflows(projectRoot)) {
    if (workflow.error) {
      problems.push(`Workflow "${workflow.name}": ${workflow.error}`);
      continue;
    }
    for (const [id, step] of Object.entries(loadWorkflow(projectRoot, workflow.name).steps)) {
      if (step.role && !findRole(step.role, ctx)) {
        problems.push(`Workflow "${workflow.name}", step "${id}": unknown role "${step.role}"`);
      }
    }
  }
  return problems;
}

/** Every problem `dwa config check` reports; `dwa doctor` shows the same list. */
export async function configProblems(projectRoot: string): Promise<string[]> {
  const ctx: RoleContext = { projectRoot };
  let config: Config;
  try {
    config = await loadConfig(projectRoot);
  } catch (error) {
    // Nothing else can be judged without a config that parses.
    return [(error as Error).message];
  }
  return [...checkSessions(config, ctx), ...checkWorkflows(projectRoot, ctx)];
}

export async function configCommand(projectRoot: string, args: string[]): Promise<number> {
  if (args[0] !== "check") {
    console.error(`Usage: ${APP_NAME} config check`);
    return 1;
  }
  const problems = await configProblems(projectRoot);
  if (problems.length === 0) {
    const count = listRoles({ projectRoot }).length;
    console.log(`Configuration is fine: ${count} role${count === 1 ? "" : "s"} checked.`);
    return 0;
  }
  for (const problem of problems) console.error(problem);
  return 1;
}
