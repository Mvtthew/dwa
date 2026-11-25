import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  CAPABILITY_KEYS,
  type Capabilities,
  ConfigError,
  capabilityFields,
  EFFORT_LEVELS,
  type Effort,
  formatIssues,
  layerCapabilities,
  NAME_PATTERN,
  type PermissionMode,
  pickCapabilities,
  refuseBothToolLists,
} from "./capabilities.ts";
import type { Config, McpServerConfig } from "./config.ts";
import {
  expandPath,
  projectSkillsDir,
  rolesDir,
  skillsDir,
  userRolesDir,
  userSkillsDir,
} from "./paths.ts";
import { type ItemEntry, type ItemKind, type ItemRef, listItems, type Scope } from "./scope.ts";

export { EFFORT_LEVELS, type Effort };

type Env = Record<string, string | undefined>;

/**
 * A role: what a session may use and the instructions it works by. One TOML file per role in
 * `.dwa/roles/`, or in the personal `~/.config/dwa/roles/` for roles used in every project.
 */
const RoleSchema = z
  .strictObject({
    /** One line for lists and menus. */
    description: z.string().optional(),
    /** A role this one starts from. Whatever is set here replaces the parent's value. */
    extends: z.string().regex(NAME_PATTERN).optional(),
    /** Instructions for the session, added to its system prompt. */
    prompt: z.string().optional(),
    ...capabilityFields,
  })
  .superRefine(refuseBothToolLists);

export type Role = z.infer<typeof RoleSchema>;

export function parseRole(text: string, source: string): Role {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (error) {
    throw new ConfigError(`${source}: invalid TOML: ${(error as Error).message}`);
  }
  const result = RoleSchema.safeParse(raw);
  if (!result.success) throw new ConfigError(`${source}: ${formatIssues(result.error)}`);
  return result.data;
}

/** The file system as role resolution needs it; tests pass their own. */
export interface RoleFiles {
  /** Text of a file, or null when it does not exist. */
  read(path: string): string | null;
  exists(path: string): boolean;
  /** Names of the entries in a directory; empty when it does not exist. */
  list(path: string): string[];
  /** Full path of a command found on PATH, or null. */
  which(command: string): string | null;
}

export const diskFiles: RoleFiles = {
  read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  exists: (path) => existsSync(path),
  list: (path) => (existsSync(path) ? readdirSync(path) : []),
  which: (command) => Bun.which(command),
};

/** Origin (see `Origins`) of a value from `[defaults]` in the personal config. */
export const PERSONAL_DEFAULTS = "personal defaults";

export interface RoleContext {
  projectRoot: string;
  env?: Env;
  files?: RoleFiles;
}

export type RoleSource = Scope;

export interface RoleEntry {
  name: string;
  source: RoleSource;
  path: string;
}

export interface LoadedRole extends RoleEntry {
  role: Role;
}

function roleDirs(ctx: RoleContext): [RoleSource, string][] {
  return [
    ["project", rolesDir(ctx.projectRoot)],
    ["user", userRolesDir(ctx.env)],
  ];
}

/** Role files as a kind of file kept in the project and in the personal folder. */
export const roleKind: ItemKind = {
  id: "roles",
  label: "role",
  dir: (source, ctx) => (source === "user" ? userRolesDir(ctx.env) : rolesDir(ctx.projectRoot)),
  valid: (name) => NAME_PATTERN.test(name),
};

/**
 * Every role file in both places, for the editors. A personal role the project has one of the
 * same name for is `hidden`: no session here runs as it.
 */
export function listAllRoles(ctx: RoleContext): ItemEntry[] {
  return listItems(roleKind, { ...ctx, files: ctx.files ?? diskFiles });
}

/** Every role a session in this project can run as. A project role hides a personal one of the same name. */
export function listRoles(ctx: RoleContext): RoleEntry[] {
  return listAllRoles(ctx)
    .filter((entry) => !entry.hidden)
    .map(({ name, source, path }) => ({ name, source, path }));
}

/** Reads the role file in one place, hidden or not. Null when that place has none of the name. */
export function findRoleIn(ref: ItemRef, ctx: RoleContext): LoadedRole | null {
  if (!NAME_PATTERN.test(ref.name)) return null;
  const path = join(roleKind.dir(ref.source, ctx), `${ref.name}.toml`);
  const text = (ctx.files ?? diskFiles).read(path);
  return text === null ? null : { ...ref, path, role: parseRole(text, path) };
}

/** Reads a role: the project's file, otherwise the personal one. Null when there is neither. */
export function findRole(name: string, ctx: RoleContext): LoadedRole | null {
  if (!NAME_PATTERN.test(name)) return null;
  const files = ctx.files ?? diskFiles;
  for (const [source, dir] of roleDirs(ctx)) {
    const path = join(dir, `${name}.toml`);
    const text = files.read(path);
    if (text !== null) return { name, source, path, role: parseRole(text, path) };
  }
  return null;
}

function missingRole(name: string, ctx: RoleContext): ConfigError {
  const files = ctx.files ?? diskFiles;
  const expected = join(rolesDir(ctx.projectRoot), `${name}.toml`);
  const native = join(ctx.projectRoot, ".claude", "agents", `${name}.md`);
  const hint = files.exists(native)
    ? ` ${native} is no longer used as a role: move its prompt and settings into that file.`
    : "";
  const known = listRoles(ctx).map((entry) => entry.name);
  const available = known.length > 0 ? ` Roles here: ${known.join(", ")}.` : "";
  return new ConfigError(`Unknown role "${name}": there is no ${expected}.${hint}${available}`);
}

/** The role and what it extends, the most distant parent first. */
function roleChain(name: string, ctx: RoleContext): LoadedRole[] {
  const chain: LoadedRole[] = [];
  const seen: string[] = [];
  let next: string | undefined = name;
  while (next !== undefined) {
    if (seen.includes(next)) {
      throw new ConfigError(
        `Role "${name}": extends forms a loop (${[...seen, next].join(" → ")})`,
      );
    }
    seen.push(next);
    const loaded = findRole(next, ctx);
    if (!loaded) throw missingRole(next, ctx);
    chain.unshift(loaded);
    next = loaded.role.extends;
  }
  return chain;
}

export type SkillSource = "project" | "dwa" | "user";

export interface ResolvedSkill {
  name: string;
  /** "project" skills are loaded by Claude Code itself; the others are handed to the session by dwa. */
  source: SkillSource;
  /** The skill's directory. */
  path: string;
}

/** Everything a session is started with, after all layers. Stored with the agent as it is. */
export interface ResolvedSession {
  role?: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  /** Built-in tools the session is limited to; absent means all of them. */
  tools?: string[];
  denyTools: string[];
  allow: string[];
  deny: string[];
  mcp: Record<string, McpServerConfig>;
  plugins: { name: string; path: string }[];
  /** Skills the session is limited to; absent means every project skill. */
  skills?: ResolvedSkill[];
  /** Project skills this session must not use (only when `skills` is given). */
  hiddenSkills: string[];
  /** Servers of the project's `.mcp.json` this session does not get. */
  offMcp: string[];
  /** Built-in plugins and skills of the Claude command that are switched off. */
  offPlugins: string[];
  offSkills: string[];
  /** Whether the session uses the Claude command's own per-project memory. */
  memory: boolean;
  prompt?: string;
}

/** The short form of a resolved session for lists and panes: names only, no definitions. */
export interface SessionSummary {
  model?: string;
  effort?: string;
  permissionMode?: string;
  tools?: string[];
  denyTools: string[];
  allow: string[];
  deny: string[];
  mcp: string[];
  plugins: string[];
  skills?: string[];
  memory: boolean;
}

export function summarizeSession(session: ResolvedSession): SessionSummary {
  return {
    model: session.model,
    effort: session.effort,
    permissionMode: session.permissionMode,
    tools: session.tools,
    denyTools: session.denyTools,
    allow: session.allow,
    deny: session.deny,
    mcp: Object.keys(session.mcp),
    plugins: session.plugins.map((plugin) => plugin.name),
    skills: session.skills?.map((skill) => skill.name),
    memory: session.memory,
  };
}

export interface SessionRequest {
  config: Config;
  /** Role to run as; an agent without one gets `[defaults]` only. */
  role?: string;
  /** The main session: its role and overrides come from `[main]`. */
  main?: boolean;
  /**
   * Values every session of the role gets for as long as the workspace runs ("save for this
   * agent and the next ones"). They sit on the role, under what one session is given.
   */
  roleRun?: Capabilities;
  /** Values for this one session, on top of the role. */
  overrides?: Capabilities;
  /**
   * The request comes from an agent (`spawn_agent`), so `overrides` may only take away from the
   * role: more denied tools and rules, fewer servers, plugins and skills. Model and effort are free.
   */
  narrowOnly?: boolean;
  /** Changes saved for the one running session; they win over everything else. */
  agent?: Capabilities;
}

/**
 * Where a value comes from: "defaults", "role <name>", "run" (the role for this workspace
 * run), "session" (given when the session was started) or "agent" (changed while it ran).
 */
export type Origins = Partial<Record<keyof Capabilities, string>>;

export interface Layers {
  role?: string;
  /** The role and what it extends, the most distant parent first. */
  chain: LoadedRole[];
  caps: Capabilities;
  origins: Origins;
}

const WIDENING_KEYS = ["tools", "allow", "permission_mode"] as const;
const NARROWING_LISTS = ["deny", "off_mcp", "off_plugins", "off_skills"] as const;

function isSkill(dir: string, files: RoleFiles): boolean {
  return files.exists(join(dir, "SKILL.md"));
}

function projectSkillNames(ctx: RoleContext): string[] {
  const files = ctx.files ?? diskFiles;
  const dir = projectSkillsDir(ctx.projectRoot);
  return files
    .list(dir)
    .filter((name) => isSkill(join(dir, name), files))
    .sort();
}

function findSkill(name: string, ctx: RoleContext): ResolvedSkill | null {
  const files = ctx.files ?? diskFiles;
  const places: [SkillSource, string][] = [
    ["project", projectSkillsDir(ctx.projectRoot)],
    ["dwa", skillsDir(ctx.projectRoot)],
    ["user", userSkillsDir(ctx.env)],
  ];
  for (const [source, dir] of places) {
    const path = join(dir, name);
    if (isSkill(path, files)) return { name, source, path };
  }
  return null;
}

function without(list: string[], removed: string[]): string[] {
  return list.filter((item) => !removed.includes(item));
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function requireSubset(what: string, wanted: string[], available: string[], who: string): void {
  const extra = without(wanted, available);
  if (extra.length === 0) return;
  throw new ConfigError(
    `${who}: an agent can only narrow a role, and ${what} ${extra.map((name) => `"${name}"`).join(", ")} ` +
      `${extra.length === 1 ? "is" : "are"} not part of it (it has: ${available.join(", ") || "none"})`,
  );
}

/** Takes away from `caps` what an agent's spawn request asks to remove; refuses anything wider. */
function narrow(
  caps: Capabilities,
  request: Capabilities,
  who: string,
  ctx: RoleContext,
): Capabilities {
  for (const key of WIDENING_KEYS) {
    if (request[key] !== undefined) {
      throw new ConfigError(`${who}: an agent can only narrow a role, so it cannot set ${key}`);
    }
  }
  const result: Capabilities = { ...caps };
  if (request.model !== undefined) result.model = request.model;
  if (request.effort !== undefined) result.effort = request.effort;
  if (request.deny_tools !== undefined) {
    if (result.tools !== undefined) result.tools = without(result.tools, request.deny_tools);
    else result.deny_tools = union(result.deny_tools ?? [], request.deny_tools);
  }
  if (request.memory === true) {
    throw new ConfigError(`${who}: an agent can only narrow a role, so it cannot turn memory on`);
  }
  if (request.memory === false) result.memory = false;
  for (const key of NARROWING_LISTS) {
    const more = request[key];
    if (more !== undefined) result[key] = union(result[key] ?? [], more);
  }
  if (request.mcp !== undefined) {
    requireSubset("MCP server", request.mcp, caps.mcp ?? [], who);
    result.mcp = request.mcp;
  }
  if (request.plugins !== undefined) {
    requireSubset("plugin", request.plugins, caps.plugins ?? [], who);
    result.plugins = request.plugins;
  }
  if (request.skills !== undefined) {
    // Without a list the role has every project skill, and nothing from the dwa skill folders.
    requireSubset("skill", request.skills, caps.skills ?? projectSkillNames(ctx), who);
    result.skills = request.skills;
  }
  return result;
}

/**
 * Puts the layers of a session on top of each other and remembers which one each value is
 * from: `[defaults]`, the role's parents, the role, the role's values for this workspace run,
 * what the session was given at its start, and what was changed for it while it ran.
 */
export function resolveLayers(request: SessionRequest, ctx: RoleContext): Layers {
  const { config } = request;
  let roleName = request.role;
  let overrides = pickCapabilities(request.overrides ?? {});
  if (request.main) {
    // "main" is the role by convention; without that file the main session runs on the defaults.
    roleName = config.main.role ?? (findRole("main", ctx) ? "main" : undefined);
    overrides = pickCapabilities({ model: config.main.model, effort: config.main.effort });
  }

  const chain = roleName === undefined ? [] : roleChain(roleName, ctx);
  const who = roleName === undefined ? "Session without a role" : `Role "${roleName}"`;
  let caps: Capabilities = {};
  const origins: Origins = {};
  const put = (next: Capabilities, origin: string) => {
    for (const key of CAPABILITY_KEYS) {
      if (JSON.stringify(next[key]) !== JSON.stringify(caps[key])) {
        if (next[key] === undefined) delete origins[key];
        else origins[key] = origin;
      }
    }
    caps = next;
  };
  // `config.defaults` already has the personal values under the project's; putting the
  // personal ones first only tells the two files apart in the origins.
  if (config.userDefaults) put(pickCapabilities(config.userDefaults), PERSONAL_DEFAULTS);
  put(pickCapabilities(config.defaults), "defaults");
  // A value both files set is the project's: that file decides it here.
  for (const key of CAPABILITY_KEYS) {
    if (config.projectDefaults?.[key] !== undefined && origins[key]) origins[key] = "defaults";
  }
  for (const loaded of chain) put(layerCapabilities(caps, loaded.role), `role ${loaded.name}`);
  put(layerCapabilities(caps, pickCapabilities(request.roleRun ?? {})), "run");
  put(
    request.narrowOnly ? narrow(caps, overrides, who, ctx) : layerCapabilities(caps, overrides),
    "session",
  );
  put(layerCapabilities(caps, pickCapabilities(request.agent ?? {})), "agent");
  return { role: roleName, chain, caps, origins };
}

/**
 * Works out what a session is started with from its layers (`resolveLayers`). Throws
 * `ConfigError` for anything that does not exist: the role, a parent, a catalogue entry or
 * a skill.
 */
export function resolveSession(request: SessionRequest, ctx: RoleContext): ResolvedSession {
  const { config } = request;
  const { role: roleName, chain, caps } = resolveLayers(request, ctx);
  const who = roleName === undefined ? "Session without a role" : `Role "${roleName}"`;

  const lookup = <T>(kind: string, names: string[], entries: Record<string, T>): [string, T][] =>
    names.map((name) => {
      const entry = entries[name];
      if (entry === undefined) {
        const known = Object.keys(entries).join(", ") || "none defined";
        throw new ConfigError(`${who}: unknown ${kind} "${name}" (in config.toml: ${known})`);
      }
      return [name, entry];
    });

  let skills: ResolvedSkill[] | undefined;
  let hiddenSkills: string[] = [];
  if (caps.skills !== undefined) {
    skills = caps.skills.map((name) => {
      const skill = findSkill(name, ctx);
      if (!skill) {
        throw new ConfigError(
          `${who}: unknown skill "${name}" (looked for ${name}/SKILL.md in ` +
            `${projectSkillsDir(ctx.projectRoot)}, ${skillsDir(ctx.projectRoot)} and ${userSkillsDir(ctx.env)})`,
        );
      }
      return skill;
    });
    hiddenSkills = without(projectSkillNames(ctx), caps.skills);
  }

  // The prompt is inherited like any other value: the nearest role that has one gives it.
  const prompt = chain.findLast((loaded) => loaded.role.prompt !== undefined)?.role.prompt;

  return {
    role: roleName,
    model: caps.model,
    effort: caps.effort,
    permissionMode: caps.permission_mode,
    tools: caps.tools,
    denyTools: caps.deny_tools ?? [],
    allow: caps.allow ?? [],
    deny: caps.deny ?? [],
    mcp: Object.fromEntries(lookup("MCP server", caps.mcp ?? [], config.mcp)),
    plugins: lookup("plugin", caps.plugins ?? [], config.plugins).map(([name, plugin]) => ({
      name,
      path: plugin.path,
    })),
    skills,
    hiddenSkills,
    offMcp: caps.off_mcp ?? [],
    offPlugins: caps.off_plugins ?? [],
    offSkills: caps.off_skills ?? [],
    memory: caps.memory ?? false,
    prompt: prompt?.trim() ? prompt : undefined,
  };
}

/**
 * What the session needs from this machine and does not find: an MCP server's command or a
 * plugin's directory. Empty when everything is there.
 */
export function missingOnThisMachine(session: ResolvedSession, ctx: RoleContext): string[] {
  const files = ctx.files ?? diskFiles;
  const problems: string[] = [];
  for (const [name, server] of Object.entries(session.mcp)) {
    if (!("command" in server)) continue;
    const command = expandPath(server.command, ctx.env);
    // A command with a slash is a path, taken from the project like the session's own directory.
    const found = command.includes("/")
      ? files.exists(isAbsolute(command) ? command : resolve(ctx.projectRoot, command))
      : files.which(command) !== null;
    if (!found) problems.push(`MCP server "${name}": command "${server.command}" was not found`);
  }
  for (const plugin of session.plugins) {
    if (!files.exists(plugin.path)) {
      problems.push(`plugin "${plugin.name}": ${plugin.path} does not exist`);
    }
  }
  return problems;
}

/** A session's capabilities as label and text pairs, for `dwa role show` and the panes. */
export function capabilityLines(summary: SessionSummary): [string, string][] {
  const list = (items: string[]) => items.join(", ") || "none";
  const lines: [string, string][] = [];
  if (summary.model) lines.push(["model", summary.model]);
  if (summary.effort) lines.push(["effort", summary.effort]);
  if (summary.permissionMode) lines.push(["permissions", summary.permissionMode]);
  if (summary.tools) lines.push(["tools", `only ${list(summary.tools)}`]);
  else if (summary.denyTools.length > 0)
    lines.push(["tools", `all except ${list(summary.denyTools)}`]);
  else lines.push(["tools", "all"]);
  if (summary.allow.length > 0) lines.push(["allow", list(summary.allow)]);
  if (summary.deny.length > 0) lines.push(["deny", list(summary.deny)]);
  lines.push(["mcp", list(summary.mcp)]);
  lines.push(["plugins", list(summary.plugins)]);
  lines.push(["skills", summary.skills ? list(summary.skills) : "all project skills"]);
  if (summary.memory) lines.push(["memory", "on"]);
  return lines;
}

/**
 * Everything wrong with the roles as configured: each role file, the main session and the
 * agents started with the workspace are resolved as they would be at start. Empty when all is well.
 */
export function checkSessions(config: Config, ctx: RoleContext): string[] {
  const problems: string[] = [];
  const attempt = (label: string, request: SessionRequest) => {
    try {
      const session = resolveSession(request, ctx);
      for (const missing of missingOnThisMachine(session, ctx))
        problems.push(`${label}: ${missing}`);
    } catch (error) {
      const message = (error as Error).message;
      // Most messages already start by naming the role they are about.
      problems.push(message.startsWith("Role ") ? message : `${label}: ${message}`);
    }
  };
  for (const role of listRoles(ctx)) attempt(`Role "${role.name}"`, { config, role: role.name });
  attempt("Main session", { config, main: true });
  attempt("Session without a role", { config });
  for (const agent of config.agents) {
    attempt(`Agent "${agent.name}"`, { config, role: agent.role, overrides: agent });
  }
  return [...new Set(problems)];
}

/** What a project role that starts from a personal one means for the others on the project. */
export function personalParentNote(name: string, parent: string): string {
  return (
    `Role "${name}" is in the project but starts from your personal role "${parent}", ` +
    "which others who use this project do not have."
  );
}

/**
 * Things about the two places that are worth knowing and break nothing here: a personal role
 * the project hides, and a project role that depends on a personal one.
 */
export function scopeNotes(ctx: RoleContext): string[] {
  const notes: string[] = [];
  for (const entry of listAllRoles(ctx)) {
    if (entry.hidden) {
      notes.push(
        `Your personal role "${entry.name}" is not used here: the project has a role of the same name.`,
      );
      continue;
    }
    if (entry.source !== "project") continue;
    try {
      const parent = findRoleIn(entry, ctx)?.role.extends;
      if (parent && findRole(parent, ctx)?.source === "user") {
        notes.push(personalParentNote(entry.name, parent));
      }
    } catch {
      // A role that does not parse is a problem `checkSessions` reports.
    }
  }
  return notes;
}
