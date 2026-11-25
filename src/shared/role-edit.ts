// Changes to role files and to `[defaults]` made by dwa itself: the tools dialog, the role
// settings and the `role` command. Every write keeps the rest of the file as it is and adds
// a version to the history.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
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
import {
  findRole,
  findRoleIn,
  listAllRoles,
  listRoles,
  PERSONAL_DEFAULTS,
  parseRole,
  personalParentNote,
  type RoleContext,
  type RoleEntry,
  roleKind,
} from "./roles.ts";
import { type ItemEntry, moveItem, requireItem, type Scope } from "./scope.ts";
import { mapValues, setKeys, type TomlValue } from "./toml.ts";
import { followRoleRename, roleMentions } from "./workflow-edit.ts";

/**
 * A file capability values can be saved in. Without `source` a role is the one sessions here
 * use (the project's before a personal one) and the defaults are the project's.
 */
export type FileTarget =
  | { kind: "role"; name: string; source?: Scope }
  | { kind: "defaults"; source?: Scope };

/** A role by name (the one that is used), or by place and name. */
export type RoleRef = string | { name: string; source?: Scope };

/** Keys of a role file besides the capability fields. */
export type RoleFields = Capabilities & { description?: string; extends?: string; prompt?: string };

/** Values to set; `null` removes the key from the file. */
export type RoleChanges = { [K in keyof RoleFields]?: RoleFields[K] | null };

/** Keys that stay at the end of a role file when others are added. */
const LAST_KEYS = ["prompt"];

/** The file a value with this origin (see `Origins`) is written in, if it is one dwa edits. */
export function originTarget(origin: string | undefined): FileTarget | null {
  if (origin === "defaults") return { kind: "defaults" };
  if (origin === PERSONAL_DEFAULTS) return { kind: "defaults", source: "user" };
  if (origin?.startsWith("role ")) return { kind: "role", name: origin.slice("role ".length) };
  return null;
}

export function describeTarget(target: FileTarget): string {
  if (target.kind === "defaults") {
    return target.source === "user"
      ? "[defaults] in your personal config.toml"
      : "[defaults] in config.toml";
  }
  return target.source === "user" ? `your personal role ${target.name}` : `role ${target.name}`;
}

/** The role's file, hidden or not. Throws when there is none. */
export function requireRole(ref: RoleRef, ctx: RoleContext): ItemEntry {
  return requireItem(roleKind, ref, ctx);
}

function tracked(target: FileTarget, ctx: RoleContext): Tracked {
  if (target.kind === "defaults") return trackedConfig(ctx.projectRoot, target.source, ctx.env);
  return trackedRole(requireRole(target, ctx), ctx.projectRoot, ctx.env);
}

/** The history of a role's file. */
export function roleHistory(ref: RoleRef, ctx: RoleContext): Tracked {
  return trackedRole(requireRole(ref, ctx), ctx.projectRoot, ctx.env);
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
    // Relative paths in a config start from where that config is.
    parseConfig(after, file.path, target.source === "user" ? dirname(file.path) : ctx.projectRoot);
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
  // In either place: a second file of a name would hide one of the two.
  const taken = listAllRoles(ctx).find((role) => role.name === name);
  if (taken) {
    throw new ConfigError(
      taken.source === "user"
        ? `There is already a personal role "${name}".`
        : `There is already a role "${name}".`,
    );
  }
  return join(roleKind.dir(personal ? "user" : "project", ctx), `${name}.toml`);
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

/**
 * A new role with the same file content as an existing one: next to it, or in the place
 * `options.personal` names.
 */
export function duplicateRole(
  from: RoleRef,
  to: string,
  ctx: RoleContext,
  options: { personal?: boolean } = {},
): RoleEntry {
  const origin = requireRole(from, ctx);
  return createRole(to, readFileSync(origin.path, "utf8"), `copy of ${origin.name}`, ctx, {
    personal: options.personal ?? origin.source === "user",
  });
}

/**
 * Moves a role between the project and the personal folder, with its history. The name stays,
 * so what refers to it still finds it.
 */
export function moveRole(ref: RoleRef, to: Scope, ctx: RoleContext): RoleEntry {
  const { name, source, path } = moveItem(roleKind, requireRole(ref, ctx), to, ctx);
  return { name, source, path };
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

/** The config files a role can be named in, the project's first. */
function configFiles(ctx: RoleContext): { file: Tracked; label: string }[] {
  return [
    { file: trackedConfig(ctx.projectRoot), label: "config.toml" },
    { file: trackedConfig(ctx.projectRoot, "user", ctx.env), label: "your personal config.toml" },
  ];
}

/**
 * What refers to a role in the files: child roles, `[main]`, `[[agents]]` entries and
 * workflow steps. Sessions that are running as the role are the daemon's to know. A hidden
 * personal role has no users here: its name means the project's role.
 */
export function roleUsers(ref: RoleRef, ctx: RoleContext): string[] {
  const entry = requireRole(ref, ctx);
  if (entry.hidden) return [];
  const { name } = entry;
  const users: string[] = [];
  for (const role of listRoles(ctx)) {
    if (role.name !== name && mentions(role.path, name).length > 0) {
      users.push(`role ${role.name} extends it`);
    }
  }
  for (const { file, label } of configFiles(ctx)) {
    if (!existsSync(file.path)) continue;
    for (const table of mentions(file.path, name)) {
      users.push(
        table === "main" ? `the main session ([main] in ${label})` : `[[${table}]] in ${label}`,
      );
    }
  }
  for (const { workflow, step, personal } of roleMentions(name, ctx)) {
    users.push(`${personal ? "your personal workflow" : "workflow"} ${workflow}, step ${step}`);
  }
  return users;
}

/** Deletes a role file. Refused while files refer to it. Its history stays. */
export function deleteRole(ref: RoleRef, ctx: RoleContext): void {
  const entry = requireRole(ref, ctx);
  const users = roleUsers(entry, ctx);
  if (users.length > 0) {
    throw new ConfigError(`Role "${entry.name}" is still used: ${users.join("; ")}.`);
  }
  record(trackedRole(entry, ctx.projectRoot, ctx.env), BY_HAND);
  rmSync(entry.path);
}

/**
 * Renames a role and follows the new name through everything that refers to it: child roles,
 * the two configs and the project's workflows. The history moves with the file. A hidden
 * personal role is only renamed: what names it here means the project's role.
 */
export function renameRole(ref: RoleRef, to: string, ctx: RoleContext): RoleEntry {
  const entry = requireRole(ref, ctx);
  const from = entry.name;
  const path = newRolePath(to, ctx, entry.source === "user");
  const renamed: RoleEntry = { name: to, source: entry.source, path };
  const oldHistory = trackedRole(entry, ctx.projectRoot, ctx.env);
  record(oldHistory, BY_HAND);

  const follow = (file: Tracked) => {
    if (!existsSync(file.path) || mentions(file.path, from).length === 0) return;
    const text = mapValues(readFileSync(file.path, "utf8"), (_table, key, value) =>
      (key === "role" || key === "extends") && value === from ? to : undefined,
    );
    saveTracked(file, text, `role ${from} renamed to ${to}`);
  };
  if (!entry.hidden) {
    for (const role of listRoles(ctx)) {
      if (role.name !== from) follow(trackedRole(role, ctx.projectRoot, ctx.env));
    }
    for (const { file } of configFiles(ctx)) follow(file);
    followRoleRename(from, to, ctx);
  }

  mkdirSync(join(path, ".."), { recursive: true });
  renameSync(entry.path, path);
  moveHistory(oldHistory, trackedRole(renamed, ctx.projectRoot, ctx.env));
  return renamed;
}

/**
 * What a change means beyond this project's files, for the user to read before or after it:
 * other projects that share a personal role, a personal role that comes out from behind the
 * project's, a project role left depending on a personal one.
 */
export function scopeWarnings(
  action: "save" | "rename" | "delete" | "move",
  ref: RoleRef,
  ctx: RoleContext,
): string[] {
  const entry = requireRole(ref, ctx);
  const { name } = entry;
  const warnings: string[] = [];
  const readExtends = (role: ItemEntry): string | undefined => {
    try {
      return findRoleIn(role, ctx)?.role.extends;
    } catch {
      return undefined;
    }
  };
  if (action === "save") {
    const parent = readExtends(entry);
    if (entry.source === "project" && parent && findRole(parent, ctx)?.source === "user") {
      warnings.push(personalParentNote(name, parent));
    }
    return warnings;
  }
  if (entry.source === "user") {
    const what =
      action === "rename"
        ? "still name it by the old name"
        : action === "delete"
          ? "will no longer find it"
          : "will no longer find it among your personal roles";
    warnings.push(
      `Other projects that use your personal role "${name}" are not checked: they ${what}.`,
    );
    return warnings;
  }
  if (action === "move") {
    warnings.push(`Others who use this project will no longer have role "${name}".`);
    const children = listRoles(ctx).filter(
      (role) => role.source === "project" && role.name !== name && mentions(role.path, name).length,
    );
    for (const child of children) warnings.push(personalParentNote(child.name, name));
    return warnings;
  }
  const twin = listAllRoles(ctx).find((role) => role.name === name && role.hidden);
  if (twin) {
    warnings.push(
      `Your personal role "${name}" is hidden by this one and will be the one used here afterwards.`,
    );
  }
  return warnings;
}

/**
 * Brings the history up to date with what is on disk, so a role or config changed in an
 * editor gets its version. Called wherever dwa reads these files on the user's behalf.
 */
export function noticeEdits(ctx: RoleContext): void {
  try {
    for (const role of listAllRoles(ctx)) {
      record(trackedRole(role, ctx.projectRoot, ctx.env), BY_HAND);
    }
    for (const { file } of configFiles(ctx)) record(file, BY_HAND);
  } catch {
    // History is a convenience; a folder that cannot be written must not stop a session.
  }
}
