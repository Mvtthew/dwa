// Changes to role files and to `[defaults]` made by dwa itself: the tools dialog, the role
// settings and the `role` command. Every write keeps the rest of the file as it is and adds
// a version to the history.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CAPABILITY_KEYS, type Capabilities, ConfigError, NAME_PATTERN } from "./capabilities.ts";
import { parseConfig } from "./config.ts";
import {
  BY_HAND,
  moveHistory,
  record,
  saveTracked,
  type Tracked,
  trackedConfig,
  trackedRole,
  type Version,
} from "./history.ts";
import { projectConfigPath, rolesDir, userRolesDir, workflowsDir } from "./paths.ts";
import { findRole, listRoles, parseRole, type RoleContext, type RoleEntry } from "./roles.ts";
import { mapValues, setKeys, type TomlValue } from "./toml.ts";

/** A file capability values can be saved in. */
export type FileTarget = { kind: "role"; name: string } | { kind: "defaults" };

/** Keys of a role file besides the capability fields. */
export type RoleFields = Capabilities & { description?: string; extends?: string; prompt?: string };

/** Values to set; `null` removes the key from the file. */
export type RoleChanges = { [K in keyof RoleFields]?: RoleFields[K] | null };

/** Keys that stay at the end of a role file when others are added. */
const LAST_KEYS = ["prompt"];

/** The file a value with this origin (see `Origins`) is written in, if it is one dwa edits. */
export function originTarget(origin: string | undefined): FileTarget | null {
  if (origin === "defaults") return { kind: "defaults" };
  if (origin?.startsWith("role ")) return { kind: "role", name: origin.slice("role ".length) };
  return null;
}

export function describeTarget(target: FileTarget): string {
  return target.kind === "defaults" ? "[defaults] in config.toml" : `role ${target.name}`;
}

function requireRole(name: string, ctx: RoleContext): RoleEntry {
  const entry = listRoles(ctx).find((role) => role.name === name);
  if (!entry) throw new ConfigError(`Unknown role "${name}".`);
  return entry;
}

function tracked(target: FileTarget, ctx: RoleContext): Tracked {
  if (target.kind === "defaults") return trackedConfig(ctx.projectRoot);
  return trackedRole(requireRole(target.name, ctx), ctx.projectRoot, ctx.env);
}

/** The history of a role's file. */
export function roleHistory(name: string, ctx: RoleContext): Tracked {
  return tracked({ kind: "role", name }, ctx);
}

function tomlChanges(changes: RoleChanges): Record<string, TomlValue | undefined> {
  const out: Record<string, TomlValue | undefined> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    out[key] = value === null ? undefined : (value as TomlValue);
  }
  // The two tool lists are one choice: a file that gets one loses the other.
  if (changes.tools != null && !("deny_tools" in changes)) out.deny_tools = undefined;
  if (changes.deny_tools != null && !("tools" in changes)) out.tools = undefined;
  return out;
}

/**
 * Writes values into a role file or into `[defaults]`. The new text has to be a valid role or
 * config, otherwise nothing is written. Returns the version the file is at afterwards.
 */
export function saveValues(
  target: FileTarget,
  changes: RoleChanges,
  source: string,
  ctx: RoleContext,
  now: Date = new Date(),
): Version {
  const file = tracked(target, ctx);
  const before = existsSync(file.path) ? readFileSync(file.path, "utf8") : "";
  const edits = tomlChanges(changes);
  // Removing a key that is not there is not a change.
  for (const key of Object.keys(edits)) {
    if (edits[key] !== undefined) continue;
    const parsed = Bun.TOML.parse(before) as Record<string, Record<string, unknown>>;
    const holder = target.kind === "defaults" ? (parsed.defaults ?? {}) : parsed;
    if (!(key in holder)) delete edits[key];
  }
  let after: string;
  if (target.kind === "defaults") {
    const allowed = CAPABILITY_KEYS as string[];
    const extra = Object.keys(edits).filter((key) => !allowed.includes(key));
    if (extra.length > 0) throw new ConfigError(`[defaults] cannot hold ${extra.join(", ")}.`);
    after = setKeys(before, "defaults", edits);
    parseConfig(after, file.path, ctx.projectRoot);
  } else {
    after = setKeys(before, null, edits, LAST_KEYS);
    parseRole(after, file.path);
    if (changes.extends != null) checkParents(target.name, changes.extends, ctx);
  }
  return saveTracked(file, after, source, now);
}

/** Refuses a parent that does not exist or that leads back to the role itself. */
function checkParents(name: string, parent: string, ctx: RoleContext): void {
  const seen = [name];
  let next: string | undefined = parent;
  while (next !== undefined) {
    if (seen.includes(next)) {
      throw new ConfigError(
        `Role "${name}": extends would form a loop (${[...seen, next].join(" → ")})`,
      );
    }
    seen.push(next);
    const loaded = findRole(next, ctx);
    if (!loaded) throw new ConfigError(`Role "${name}": there is no role "${next}" to extend.`);
    next = loaded.role.extends;
  }
}

function newRolePath(name: string, ctx: RoleContext, personal: boolean): string {
  if (!NAME_PATTERN.test(name) || name.length > 40) {
    throw new ConfigError(
      `"${name}" cannot be a role name: use letters, digits, ".", "_" and "-".`,
    );
  }
  if (listRoles(ctx).some((role) => role.name === name)) {
    throw new ConfigError(`There is already a role "${name}".`);
  }
  return join(personal ? userRolesDir(ctx.env) : rolesDir(ctx.projectRoot), `${name}.toml`);
}

/** Creates a role file from text (a copy of another role, or a starting point). */
export function createRole(
  name: string,
  text: string,
  source: string,
  ctx: RoleContext,
  options: { personal?: boolean; now?: Date } = {},
): RoleEntry {
  const path = newRolePath(name, ctx, options.personal ?? false);
  parseRole(text, path);
  const entry: RoleEntry = { name, source: options.personal ? "user" : "project", path };
  saveTracked(trackedRole(entry, ctx.projectRoot, ctx.env), text, source, options.now);
  return entry;
}

/** What a new, empty role file starts with. */
export function roleTemplate(description: string): string {
  return `description = ${JSON.stringify(description)}\n\nprompt = """\n"""\n`;
}

/** A new role with the same file content as an existing one, next to it. */
export function duplicateRole(from: string, to: string, ctx: RoleContext): RoleEntry {
  const origin = requireRole(from, ctx);
  return createRole(to, readFileSync(origin.path, "utf8"), `copy of ${from}`, ctx, {
    personal: origin.source === "user",
  });
}

function workflowFiles(projectRoot: string): string[] {
  const dir = workflowsDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".toml"))
    .map((file) => join(dir, file));
}

/** Every `role = "<name>"` and `extends = "<name>"` in a file, as the tables they are in. */
function mentions(path: string, name: string): string[] {
  const found: string[] = [];
  try {
    mapValues(readFileSync(path, "utf8"), (table, key, value) => {
      if ((key === "role" || key === "extends") && value === name) found.push(table ?? "");
      return undefined;
    });
  } catch {
    // A file that cannot be read as TOML is reported by `config check`, not here.
  }
  return found;
}

/**
 * What refers to a role in the files: child roles, `[main]`, `[[agents]]` entries and
 * workflow steps. Sessions that are running as the role are the daemon's to know.
 */
export function roleUsers(name: string, ctx: RoleContext): string[] {
  const users: string[] = [];
  for (const role of listRoles(ctx)) {
    if (role.name !== name && mentions(role.path, name).length > 0) {
      users.push(`role ${role.name} extends it`);
    }
  }
  const config = projectConfigPath(ctx.projectRoot);
  if (existsSync(config)) {
    for (const table of mentions(config, name)) {
      users.push(
        table === "main"
          ? "the main session ([main] in config.toml)"
          : `[[${table}]] in config.toml`,
      );
    }
  }
  for (const file of workflowFiles(ctx.projectRoot)) {
    const workflow = file.slice(file.lastIndexOf("/") + 1, -".toml".length);
    for (const table of mentions(file, name)) {
      users.push(`workflow ${workflow}, step ${table.replace(/^steps\./, "")}`);
    }
  }
  return users;
}

/** Deletes a role file. Refused while files refer to it. Its history stays. */
export function deleteRole(name: string, ctx: RoleContext): void {
  const entry = requireRole(name, ctx);
  const users = roleUsers(name, ctx);
  if (users.length > 0) {
    throw new ConfigError(`Role "${name}" is still used: ${users.join("; ")}.`);
  }
  record(trackedRole(entry, ctx.projectRoot, ctx.env), BY_HAND);
  rmSync(entry.path);
}

/**
 * Renames a role and follows the new name through everything that refers to it: child roles,
 * the config and the project's workflows. The history moves with the file.
 */
export function renameRole(from: string, to: string, ctx: RoleContext): RoleEntry {
  const entry = requireRole(from, ctx);
  const path = newRolePath(to, ctx, entry.source === "user");
  const renamed: RoleEntry = { name: to, source: entry.source, path };
  const oldHistory = trackedRole(entry, ctx.projectRoot, ctx.env);
  record(oldHistory, BY_HAND);

  const follow = (file: Tracked | string) => {
    const filePath = typeof file === "string" ? file : file.path;
    if (!existsSync(filePath) || mentions(filePath, from).length === 0) return;
    const text = mapValues(readFileSync(filePath, "utf8"), (_table, key, value) =>
      (key === "role" || key === "extends") && value === from ? to : undefined,
    );
    if (typeof file === "string") writeFileSync(filePath, text);
    else saveTracked(file, text, `role ${from} renamed to ${to}`);
  };
  for (const role of listRoles(ctx)) {
    if (role.name !== from) follow(trackedRole(role, ctx.projectRoot, ctx.env));
  }
  follow(trackedConfig(ctx.projectRoot));
  for (const file of workflowFiles(ctx.projectRoot)) follow(file);

  mkdirSync(join(path, ".."), { recursive: true });
  renameSync(entry.path, path);
  moveHistory(oldHistory, trackedRole(renamed, ctx.projectRoot, ctx.env));
  return renamed;
}

/**
 * Brings the history up to date with what is on disk, so a role or config changed in an
 * editor gets its version. Called wherever dwa reads these files on the user's behalf.
 */
export function noticeEdits(ctx: RoleContext): void {
  try {
    for (const role of listRoles(ctx)) record(trackedRole(role, ctx.projectRoot, ctx.env), BY_HAND);
    record(trackedConfig(ctx.projectRoot), BY_HAND);
  } catch {
    // History is a convenience; a folder that cannot be written must not stop a session.
  }
}
