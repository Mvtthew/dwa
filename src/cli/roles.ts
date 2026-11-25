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
import { switchTo, versionText } from "../shared/history.ts";
import { runDir } from "../shared/paths.ts";
import type { WorkspaceState } from "../shared/protocol.ts";
import {
  createRole,
  deleteRole,
  duplicateRole,
  moveRole,
  noticeEdits,
  renameRole,
  requireRole,
  roleHistory,
  roleTemplate,
  saveValues,
  scopeWarnings,
} from "../shared/role-edit.ts";
import {
  capabilityLines,
  checkSessions,
  findRole,
  findRoleIn,
  listAllRoles,
  listRoles,
  parseRole,
  type ResolvedSession,
  type RoleContext,
  resolveSession,
  scopeNotes,
  summarizeSession,
} from "../shared/roles.ts";
import { parseRef, type Scope, scopeLabel } from "../shared/scope.ts";
import { listWorkflows, loadWorkflow } from "../shared/workflow.ts";
import { call } from "./client.ts";
import { openEditor } from "./editor.ts";
import { printDiff, printHistory, versionNumber } from "./versions.ts";

const ROLE_USAGE = `Usage:
  ${APP_NAME} role list [--json]            Roles of this project and your personal ones
  ${APP_NAME} role show <role> [--json]     What a session of this role is started with
  ${APP_NAME} role show --main [--json]     The same for the main session
  ${APP_NAME} role new <name> [--description <text>] [--personal]
  ${APP_NAME} role copy <role> <new name> [--to personal|project]
  ${APP_NAME} role move <role> --to personal|project   With its history; the name stays
  ${APP_NAME} role rename <role> <new name> Also changes every file that names the role
  ${APP_NAME} role delete <role>            Refused while something uses the role
  ${APP_NAME} role edit-prompt <role>       The role's prompt in $EDITOR
  ${APP_NAME} role history <role> [--json]  Versions of the role file
  ${APP_NAME} role diff <role> [vA] [vB]    What changed (the current version against the one before)
  ${APP_NAME} role switch <role> <vN>       Give the file the content of that version

A role name means the role sessions here use: the project's before a personal one of the same
name. --personal or --project (or personal:<role>, project:<role>) names one file exactly.`;

/** "personal" or "project" as a place; undefined for anything else. */
function placeOf(text: string | undefined): Scope | undefined {
  return text === "personal" ? "user" : text === "project" ? "project" : undefined;
}

function printWarnings(lines: string[]): void {
  for (const line of lines) console.log(`Note: ${line}`);
}

/** The commands that change role files or look at their history. Null when it is none of them. */
async function roleFileCommand(
  action: string | undefined,
  words: string[],
  values: {
    json?: boolean;
    personal?: boolean;
    project?: boolean;
    description?: string;
    to?: string;
  },
  ctx: RoleContext,
): Promise<number | null> {
  const [word, second, third] = words;
  if (action === "new" && word) {
    const name = word;
    const entry = createRole(name, roleTemplate(values.description ?? ""), "role new", ctx, {
      personal: values.personal,
    });
    console.log(`Created ${entry.path}`);
    return 0;
  }
  const FILE_ACTIONS = [
    "copy",
    "move",
    "rename",
    "delete",
    "edit-prompt",
    "history",
    "diff",
    "switch",
  ];
  if (!word || !action || !FILE_ACTIONS.includes(action)) return null;
  // One file exactly when a place is given, otherwise the role that is used.
  const named = parseRef(word);
  const role = requireRole(
    {
      name: named.name,
      source: values.personal ? "user" : values.project ? "project" : named.source,
    },
    ctx,
  );
  const { name } = role;
  if (action === "copy" && second) {
    const to = placeOf(values.to);
    if (values.to !== undefined && !to) {
      console.error(ROLE_USAGE);
      return 1;
    }
    const copy = duplicateRole(role, second, ctx, to ? { personal: to === "user" } : {});
    console.log(`Created ${copy.path}`);
    return 0;
  }
  if (action === "move") {
    const to = placeOf(values.to);
    if (!to) {
      console.error(ROLE_USAGE);
      return 1;
    }
    const warnings = scopeWarnings("move", role, ctx);
    console.log(`Moved to ${moveRole(role, to, ctx).path}`);
    printWarnings(warnings);
    return 0;
  }
  if ((action === "rename" || action === "delete") && !role.hidden) {
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
  if (action === "rename" && second) {
    const warnings = scopeWarnings("rename", role, ctx);
    console.log(`Renamed to ${renameRole(role, second, ctx).path}`);
    printWarnings(warnings);
    return 0;
  }
  if (action === "delete") {
    const warnings = scopeWarnings("delete", role, ctx);
    deleteRole(role, ctx);
    console.log(`Deleted role ${name}. Its history is kept.`);
    printWarnings(warnings);
    return 0;
  }
  if (action === "edit-prompt") {
    const loaded = findRoleIn(role, ctx);
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
    const version = saveValues(
      { kind: "role", name, source: role.source },
      { prompt },
      "prompt edited",
      ctx,
    );
    console.log(`Saved the prompt of role ${name} (v${version.n}).`);
    return 0;
  }
  if (action === "history") {
    printHistory(roleHistory(role, ctx), values.json);
    return 0;
  }
  if (action === "diff") {
    if (!printDiff(roleHistory(role, ctx), second, third)) {
      console.error(ROLE_USAGE);
      return 1;
    }
    return 0;
  }
  if (action === "switch") {
    const n = versionNumber(second);
    if (n === undefined) {
      console.error(ROLE_USAGE);
      return 1;
    }
    const tracked = roleHistory(role, ctx);
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
      project: { type: "boolean" },
      to: { type: "string" },
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
    const roles = listAllRoles(ctx).map((entry) => {
      try {
        const role = findRoleIn(entry, ctx)?.role;
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
      const where = role.hidden
        ? "personal, hidden by the project's role"
        : scopeLabel(role.source);
      const text = role.error ? `BROKEN: ${role.error}` : (role.description ?? "");
      console.log(`${role.name.padEnd(width)}  ${where.padEnd(8)}  ${text}`.trimEnd());
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
  // Worth knowing, but nothing is broken by them: they never change the result.
  const notes = scopeNotes({ projectRoot });
  if (problems.length === 0) {
    const count = listRoles({ projectRoot }).length;
    console.log(`Configuration is fine: ${count} role${count === 1 ? "" : "s"} checked.`);
  }
  for (const problem of problems) console.error(problem);
  if (notes.length > 0) console.log(`\nNotes:\n${notes.map((note) => `  ${note}`).join("\n")}`);
  return problems.length === 0 ? 0 : 1;
}
