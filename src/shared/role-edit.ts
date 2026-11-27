// Changes to role files and to `[defaults]` made by dwa itself: the tools dialog, the role
// settings and the `role` command. Every write keeps the rest of the file as it is and adds
// a version to the history.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CAPABILITY_KEYS, type Capabilities, ConfigError, NAME_PATTERN } from "./capabilities.ts";
import { type Config, parseConfig } from "./config.ts";
import { APP_NAME } from "./constants.ts";
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
  diskFiles,
  findRole,
  findRoleIn,
  isRoleFile,
  listAllRoles,
  listBuiltinRoles,
  listRoles,
  PERSONAL_DEFAULTS,
  parseRole,
  personalParentNote,
  type Role,
  type RoleContext,
  type RoleFile,
  resolveSession,
  roleKind,
} from "./roles.ts";
import { type ItemEntry, type ItemRef, moveItem, requireItem, type Scope } from "./scope.ts";
import {
  addArrayTable,
  addTable,
  mapValues,
  removeArrayTable,
  removeTableTree,
  setKeys,
  setKeysAt,
  type TomlValue,
} from "./toml.ts";
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
export type RoleFields = Capabilities & {
  description?: string;
  extends?: string;
  when_to_use?: string;
  role_list?: boolean;
  in_role_list?: boolean;
  profile?: string;
  prompt?: string;
};

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

/** The built-in role of that name, whether a file takes its place or not. */
export function builtinRole(name: string, ctx: RoleContext) {
  return listBuiltinRoles(ctx).find((role) => role.name === name) ?? null;
}

/** The built-in role a bare name means here: the one no file of that name stands in for. */
function unshadowedBuiltin(ref: RoleRef, ctx: RoleContext) {
  const name = typeof ref === "string" ? ref : ref.name;
  return listAllRoles(ctx).some((role) => role.name === name) ? null : builtinRole(name, ctx);
}

/**
 * The role's file, hidden or not. Throws when there is none: a role built into dwa has no
 * file to change until it is copied into the project or the personal folder.
 */
export function requireRole(ref: RoleRef, ctx: RoleContext): ItemEntry {
  try {
    return requireItem(roleKind, ref, ctx);
  } catch (error) {
    const { name, source } = typeof ref === "string" ? { name: ref, source: undefined } : ref;
    if (source === undefined && builtinRole(name, ctx)) {
      throw new ConfigError(
        `Role "${name}" is built into ${APP_NAME} and cannot be changed there. ` +
          `Copy it first: ${APP_NAME} role adopt ${name}`,
      );
    }
    throw error;
  }
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

/** A file as it is and as it would be with some values changed. */
export interface ValueEdit {
  file: Tracked;
  before: string;
  after: string;
}

/**
 * Works out the text of a role file or of a config with values changed in it, and writes
 * nothing. The new text has to be a valid role or config. `text` stands in for the file's own
 * text: that of a built-in role that is not copied into a file yet.
 */
export function editValues(
  target: FileTarget,
  changes: RoleChanges,
  ctx: RoleContext,
  text?: { path: string; before: string },
): ValueEdit {
  const file = text ? { ...trackedPlace(target, ctx, text.path) } : tracked(target, ctx);
  const before = text ? text.before : existsSync(file.path) ? readFileSync(file.path, "utf8") : "";
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
  return { file, before, after };
}

/** Where a role that has no file yet would be kept, for `editValues`. */
function trackedPlace(target: FileTarget, ctx: RoleContext, path: string): Tracked {
  if (target.kind === "defaults") return trackedConfig(ctx.projectRoot, target.source, ctx.env);
  return trackedRole(
    { name: target.name, source: target.source ?? "project", path },
    ctx.projectRoot,
    ctx.env,
  );
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
  const { file, after } = editValues(target, changes, ctx);
  return saveTracked(file, after, source, now);
}

/** The tables of a config besides `[defaults]` that dwa changes in place. */
export const CONFIG_TABLES = ["mcp", "plugins", "profiles", "agents", "main"] as const;
export type ConfigTable = (typeof CONFIG_TABLES)[number];

/**
 * One change to a config's own tables: a whole entry of a catalogue (`[mcp.<name>]`,
 * `[plugins.<name>]`, `[profiles.<name>]`) or of `[[agents]]` (by its `name`) added or, with a
 * null body, removed; or one key of such an entry or of `[main]` set or, with null, removed.
 */
export type ConfigOp =
  | {
      op: "table";
      table: Exclude<ConfigTable, "main">;
      name: string;
      body: Record<string, TomlValue> | null;
    }
  | { op: "key"; table: ConfigTable; name?: string; key: string; value: TomlValue | null };

/** The place of the `[[agents]]` entry with that name; throws when there is none or two. */
function agentIndex(text: string, name: string): number {
  const parsed = Bun.TOML.parse(text) as { agents?: { name?: unknown }[] };
  const found = (parsed.agents ?? []).flatMap((agent, index) =>
    agent.name === name ? [index] : [],
  );
  if (found.length > 1) throw new ConfigError(`[[agents]] has "${name}" more than once.`);
  if (found.length === 0) throw new ConfigError(`There is no [[agents]] entry "${name}".`);
  return found[0] as number;
}

/**
 * A config's text with changes to its own tables, everything else kept as it is. Whether the
 * result is a valid config is for the caller to check.
 */
export function editConfigText(text: string, ops: ConfigOp[]): string {
  let next = text;
  for (const change of ops) {
    const parsed = Bun.TOML.parse(next) as Record<string, unknown>;
    const entries = (parsed[change.table] ?? {}) as Record<string, unknown>;
    if (change.op === "table" && change.table === "agents") {
      if (change.body === null) {
        next = removeArrayTable(next, "agents", agentIndex(next, change.name));
      } else {
        const agents = (parsed.agents ?? []) as { name?: unknown }[];
        if (agents.some((agent) => agent.name === change.name)) {
          throw new ConfigError(`There is already an [[agents]] entry "${change.name}".`);
        }
        next = addArrayTable(next, "agents", { name: change.name, ...change.body });
      }
    } else if (change.op === "table") {
      if (!NAME_PATTERN.test(change.name)) {
        throw new ConfigError(`"${change.name}" cannot be a name in [${change.table}].`);
      }
      const table = `${change.table}.${change.name}`;
      if (change.body === null) next = removeTableTree(next, table);
      else if (change.name in entries) {
        throw new ConfigError(`There is already a [${table}]; change its keys one by one.`);
      } else next = addTable(next, table, change.body);
    } else if (change.table === "main") {
      if (change.value === null && !(change.key in entries)) continue;
      next = setKeys(next, "main", { [change.key]: change.value ?? undefined });
    } else if (change.table === "agents") {
      const index = agentIndex(next, change.name ?? "");
      const agent = (parsed.agents as Record<string, unknown>[])[index] ?? {};
      if (change.value === null && !(change.key in agent)) continue;
      next = setKeysAt(next, "agents", index, { [change.key]: change.value ?? undefined });
    } else {
      const entry = entries[change.name ?? ""] as Record<string, unknown> | undefined;
      const table = `${change.table}.${change.name}`;
      if (!entry) throw new ConfigError(`There is no [${table}].`);
      if (change.value === null && !(change.key in entry)) continue;
      next = setKeys(next, table, { [change.key]: change.value ?? undefined });
    }
  }
  return next;
}

/**
 * Works out a config's text with `[defaults]` values and its own tables changed, and writes
 * nothing. The new text has to be a valid config.
 */
export function editConfig(
  where: Scope,
  changes: RoleChanges,
  ops: ConfigOp[],
  ctx: RoleContext,
): ValueEdit {
  const first = editValues({ kind: "defaults", source: where }, changes, ctx);
  if (ops.length === 0) return first;
  const after = editConfigText(first.after, ops);
  // Relative paths in a config start from where that config is.
  parseConfig(
    after,
    first.file.path,
    where === "user" ? dirname(first.file.path) : ctx.projectRoot,
  );
  return { ...first, after };
}

/**
 * Writes `[defaults]` values and changes to a config's own tables in one version. The new text
 * has to be a valid config, otherwise nothing is written.
 */
export function saveConfig(
  where: Scope,
  changes: RoleChanges,
  ops: ConfigOp[],
  source: string,
  ctx: RoleContext,
  now: Date = new Date(),
): Version {
  const { file, after } = editConfig(where, changes, ops, ctx);
  return saveTracked(file, after, source, now);
}

/** The `[main]` keys dwa writes itself. */
export type MainChanges = {
  leader?: boolean | null;
  role?: string | null;
  model?: string | null;
  effort?: string | null;
  check_commands?: string[] | null;
};

/** What `[main]` holds in one of the two config files, as written there; empty without the file. */
export function ownMain(where: Scope, ctx: RoleContext): Record<string, unknown> {
  const { path } = trackedConfig(ctx.projectRoot, where, ctx.env);
  if (!existsSync(path)) return {};
  try {
    const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as { main?: Record<string, unknown> };
    return parsed.main ?? {};
  } catch {
    // A config that does not parse is reported where it is loaded.
    return {};
  }
}

/**
 * Writes values into `[main]` of a config file, the rest of the file kept as it is; `null`
 * removes a key. The new text has to be a valid config, otherwise nothing is written. Returns
 * the version the file is at afterwards.
 */
export function saveMain(
  changes: MainChanges,
  source: string,
  where: Scope,
  ctx: RoleContext,
  now: Date = new Date(),
): Version {
  const file = trackedConfig(ctx.projectRoot, where, ctx.env);
  const before = existsSync(file.path) ? readFileSync(file.path, "utf8") : "";
  const own = ownMain(where, ctx);
  const edits: Record<string, TomlValue | undefined> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    // Removing a key that is not there is not a change.
    if (value === null && !(key in own)) continue;
    edits[key] = value === null ? undefined : value;
  }
  const after = setKeys(before, "main", edits);
  // Relative paths in a config start from where that config is.
  parseConfig(after, file.path, where === "user" ? dirname(file.path) : ctx.projectRoot);
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

/** Refuses a name no new role can have: an unusable one, or one a role in either place has. */
export function requireFreeRoleName(name: string, ctx: RoleContext): void {
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
}

function newRolePath(name: string, ctx: RoleContext, personal: boolean): string {
  requireFreeRoleName(name, ctx);
  return join(roleKind.dir(personal ? "user" : "project", ctx), `${name}.toml`);
}

/**
 * Checks a whole role text before it becomes the file of `ref`: it has to be a valid role, and
 * a session of it has to resolve as it would at start, with the text in the file's place. So a
 * parent, an MCP server, a plugin or a skill that does not exist is refused here, by the same
 * rules a start goes by. Nothing is written.
 */
export function checkRoleText(ref: ItemRef, text: string, config: Config, ctx: RoleContext): Role {
  const role = parseRole(text, "the definition");
  const path = join(roleKind.dir(ref.source, ctx), `${ref.name}.toml`);
  const files = ctx.files ?? diskFiles;
  resolveSession(
    { config, role: ref.name },
    {
      ...ctx,
      files: {
        ...files,
        read: (file) => (file === path ? text : files.read(file)),
        exists: (file) => file === path || files.exists(file),
      },
    },
  );
  return role;
}

/**
 * Replaces a role file with a whole text somebody wrote (an agent, through `save_role`). The
 * text is written as given; it has to be a valid role with parents that exist.
 */
export function saveRoleText(
  ref: RoleRef,
  text: string,
  source: string,
  ctx: RoleContext,
  now: Date = new Date(),
): Version {
  const entry = requireRole(ref, ctx);
  const role = parseRole(text, entry.path);
  if (role.extends !== undefined) checkParents(entry.name, role.extends, ctx);
  return saveTracked(trackedRole(entry, ctx.projectRoot, ctx.env), text, source, now);
}

/** Creates a role file from text (a copy of another role, or a starting point). */
export function createRole(
  name: string,
  text: string,
  source: string,
  ctx: RoleContext,
  options: { personal?: boolean; now?: Date } = {},
): RoleFile {
  const path = newRolePath(name, ctx, options.personal ?? false);
  const role = parseRole(text, path);
  if (role.extends !== undefined) checkParents(name, role.extends, ctx);
  const entry: RoleFile = { name, source: options.personal ? "user" : "project", path };
  saveTracked(trackedRole(entry, ctx.projectRoot, ctx.env), text, source, options.now);
  return entry;
}

/**
 * Makes a file of a role built into dwa, with the same text, so it can be changed. From then
 * on the file is the role here; deleting it brings the built-in one back.
 */
export function adoptRole(
  name: string,
  ctx: RoleContext,
  options: { personal?: boolean; now?: Date } = {},
): RoleFile {
  const builtin = builtinRole(name, ctx);
  if (!builtin) throw new ConfigError(`There is no built-in role "${name}".`);
  const text = (ctx.files ?? diskFiles).read(builtin.path);
  if (text === null) throw new ConfigError(`The built-in role "${name}" cannot be read.`);
  return createRole(name, text, "copy of the built-in role", ctx, options);
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
): RoleFile {
  // A built-in role no file stands in for is copied from dwa's own text, into the project.
  const builtin = typeof from === "string" || !from.source ? unshadowedBuiltin(from, ctx) : null;
  if (builtin) {
    const text = (ctx.files ?? diskFiles).read(builtin.path) ?? "";
    return createRole(to, text, `copy of ${builtin.name}`, ctx, { personal: options.personal });
  }
  const origin = requireRole(from, ctx);
  return createRole(to, readFileSync(origin.path, "utf8"), `copy of ${origin.name}`, ctx, {
    personal: options.personal ?? origin.source === "user",
  });
}

/**
 * Moves a role between the project and the personal folder, with its history. The name stays,
 * so what refers to it still finds it.
 */
export function moveRole(ref: RoleRef, to: Scope, ctx: RoleContext): RoleFile {
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
  // A file that stands in for a built-in role leaves that role behind: the name still means one.
  const users = builtinRole(entry.name, ctx) ? [] : roleUsers(entry, ctx);
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
export function renameRole(ref: RoleRef, to: string, ctx: RoleContext): RoleFile {
  const entry = requireRole(ref, ctx);
  const from = entry.name;
  const path = newRolePath(to, ctx, entry.source === "user");
  const renamed: RoleFile = { name: to, source: entry.source, path };
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
    // A built-in role that names it cannot follow; it goes on meaning the built-in of that name.
    for (const role of listRoles(ctx).filter(isRoleFile)) {
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
