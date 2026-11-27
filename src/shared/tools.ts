// What the "Agent tools" dialog shows and what a change in it means for a session's
// capabilities. Pure: the daemon supplies what it knows about servers and tools in use.
import { ALL_TOOLS, type Capabilities, listedTools, SUBAGENT_TOOLS } from "./capabilities.ts";
import { APP_NAME } from "./constants.ts";
import type { Origins, ResolvedSession } from "./roles.ts";

/**
 * Built-in tools of the Claude command (2.1.332; see docs/spikes.md, S6), for a list to pick
 * from. A role that allows "all" has whatever the command ships; a name missing here can still
 * be typed, and one the command does not know is ignored by it.
 */
export const BUILTIN_TOOLS: readonly string[] = [
  // In every session.
  "Agent",
  "AskUserQuestion",
  "Bash",
  "Edit",
  "Read",
  "Skill",
  "ToolSearch",
  "Write",
  // There when named in an allow list (or when Bash is denied).
  "Glob",
  "Grep",
  "WaitForMcpServers",
  // Loaded when first needed.
  "NotebookEdit",
  "WebSearch",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "Monitor",
  "TaskStop",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "Workflow",
  "Artifact",
  "ArtifactComments",
  "ArtifactData",
  "ListAgents",
  "SendMessage",
  "PushNotification",
  "RemoteTrigger",
  "ReportFindings",
];

/** Name of dwa's own MCP server, which every session keeps. */
export const OWN_SERVER = "dwa";

/**
 * Whether a permission request is answered by the session's hook and never shown: one of dwa's
 * own tools in plan mode. Plan mode asks before every MCP tool call, the allowed `mcp__dwa`
 * included, and an approval on `PreToolUse` does not change that (docs/spikes.md, S6); a session
 * that plans must still be able to hand work over and talk to the others. `input` is the hook's.
 */
export function approvesOwnTool(input: unknown): boolean {
  const { tool_name: tool, permission_mode: mode } = (input ?? {}) as Record<string, unknown>;
  return mode === "plan" && typeof tool === "string" && tool.startsWith(`mcp__${OWN_SERVER}__`);
}

/** One thing the user switched in the dialog. */
export type ToolChange =
  | { kind: "tool"; name: string; on: boolean }
  | { kind: "server"; name: string; on: boolean }
  | { kind: "server-tool"; server: string; name: string; on: boolean }
  /** `on: false` takes the rule out of its list. */
  | { kind: "rule"; list: "allow" | "deny"; rule: string; on: boolean };

/** What the daemon knows beyond the session's own settings. */
export interface ToolSources {
  /** Servers of the project's `.mcp.json`. */
  projectServers: string[];
  /** Servers of the catalogue in the config. */
  catalogue: string[];
  /** Tools of a server, when dwa could ask it; null when it could not. */
  serverTools: Record<string, string[] | null>;
  /** Tool names the session has called so far. */
  seen: string[];
}

export interface ToolRow {
  name: string;
  on: boolean;
  /** Why the row cannot be switched, when it cannot. */
  fixed?: string;
}

export interface ServerRow extends ToolRow {
  from: "dwa" | "project" | "catalogue";
  /** The server's single tools; null when they are not known. */
  tools: ToolRow[] | null;
}

export interface RuleRow {
  list: "allow" | "deny";
  rule: string;
}

export interface ToolView {
  /** "only": the session has a list of built-in tools; "except": its list says "every tool". */
  mode: "only" | "except";
  tools: ToolRow[];
  servers: ServerRow[];
  rules: RuleRow[];
  /** Where the value behind each section comes from, by capability key. */
  origins: Origins;
}

const MCP_PREFIX = "mcp__";

/** The permission rule that stands for one tool of an MCP server. */
export function serverToolRule(server: string, tool: string): string {
  return `${MCP_PREFIX}${server}__${tool}`;
}

function without(list: string[], item: string): string[] {
  return list.filter((entry) => entry !== item);
}

function without2(list: string[], items: string[]): string[] {
  return list.filter((entry) => !items.includes(entry));
}

function withItem(list: string[], item: string): string[] {
  return list.includes(item) ? list : [...list, item];
}

/** The rows of the dialog for a session with these capabilities. */
export function toolView(caps: Capabilities, origins: Origins, sources: ToolSources): ToolView {
  const deny = caps.deny ?? [];
  const builtinSeen = sources.seen.filter((name) => !name.startsWith(MCP_PREFIX));
  const extra = [...(caps.tools ?? []), ...(caps.deny_tools ?? []), ...builtinSeen]
    .filter((name) => !BUILTIN_TOOLS.includes(name))
    .sort((a, b) => a.localeCompare(b));
  // The common tools first, as listed; what only this session knows comes after them.
  const names = [...new Set([...BUILTIN_TOOLS, ...extra])].filter((name) => name !== ALL_TOOLS);
  const listed = listedTools(caps);
  const tools = names.map((name) => ({
    name,
    // A deny rule that is just the tool's name blocks it as well.
    on:
      (listed === null || listed.includes(name)) &&
      !(caps.deny_tools ?? []).includes(name) &&
      !deny.includes(name) &&
      // The tools that start subagents are there only with `subagents`.
      (caps.subagents === true || !SUBAGENT_TOOLS.includes(name)),
  }));

  const serverTools = (server: string): ToolRow[] | null => {
    const prefix = `${MCP_PREFIX}${server}__`;
    const used = sources.seen
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length));
    const blocked = deny
      .filter((rule) => rule.startsWith(prefix))
      .map((rule) => rule.slice(prefix.length));
    const asked = sources.serverTools[server];
    const all = [...new Set([...(asked ?? []), ...used, ...blocked])].sort();
    if (!asked && all.length === 0) return null;
    return all.map((name) => ({ name, on: !deny.includes(serverToolRule(server, name)) }));
  };

  const servers: ServerRow[] = [
    { name: OWN_SERVER, on: true, fixed: "always on", from: "dwa", tools: null },
  ];
  // A catalogue server replaces a project server of the same name.
  for (const name of sources.projectServers.filter((n) => !sources.catalogue.includes(n))) {
    servers.push({
      name,
      on: !(caps.off_mcp ?? []).includes(name),
      from: "project",
      tools: serverTools(name),
    });
  }
  for (const name of sources.catalogue) {
    servers.push({
      name,
      on: (caps.mcp ?? []).includes(name),
      from: "catalogue",
      tools: serverTools(name),
    });
  }
  for (const server of servers) {
    if (server.name !== OWN_SERVER && deny.includes(`${MCP_PREFIX}${server.name}`))
      server.on = false;
  }

  const rules: RuleRow[] = [
    ...(caps.allow ?? []).map((rule) => ({ list: "allow" as const, rule })),
    // Rules shown as a switched-off tool above are not repeated here.
    ...deny
      .filter((rule) => !rule.startsWith(MCP_PREFIX) && !names.includes(rule))
      .map((rule) => ({ list: "deny" as const, rule })),
  ];
  return { mode: listed === null ? "except" : "only", tools, servers, rules, origins };
}

/**
 * The capability values that change when the switches in `changes` are applied to `caps`.
 * Only the keys that end up different are returned, each with its whole new value, so the
 * result can be laid over a session, over a role for one workspace run, or written to a file.
 */
export function applyToolChanges(
  caps: Capabilities,
  changes: ToolChange[],
  sources: Pick<ToolSources, "catalogue">,
): Capabilities {
  const next: Capabilities = structuredClone(caps);
  const list = (key: "tools" | "deny_tools" | "allow" | "deny" | "mcp" | "off_mcp") =>
    next[key] ?? [];
  for (const change of changes) {
    if (change.kind === "tool") {
      if (change.on && SUBAGENT_TOOLS.includes(change.name) && next.subagents !== true) {
        // `subagents` brings all of them; the ones not asked for stay off.
        next.subagents = true;
        if (!next.tools || next.tools.includes(ALL_TOOLS)) {
          for (const other of SUBAGENT_TOOLS) next.deny_tools = withItem(list("deny_tools"), other);
        }
      }
      const listed = listedTools(next);
      if (!change.on) {
        // The role's own way of saying it is kept: a list of its own loses the name, and
        // without one (or with "every tool") the name is taken away.
        if (next.tools && listed !== null) next.tools = without(next.tools, change.name);
        else next.deny_tools = withItem(list("deny_tools"), change.name);
      } else if (listed === null || listed.includes(change.name)) {
        if (next.deny_tools) next.deny_tools = without(next.deny_tools, change.name);
      } else {
        // Not in the list the session has, the default one included: the list is written
        // out with the tool in it, and what was taken away is taken out of it, since one
        // file holds either list.
        next.tools = [...without2(listed, list("deny_tools")), change.name];
        next.deny_tools = undefined;
      }
      // Allowing a tool also lifts a deny rule that names it.
      if (change.on && list("deny").includes(change.name))
        next.deny = without(list("deny"), change.name);
    } else if (change.kind === "server") {
      if (change.name === OWN_SERVER) continue;
      const rule = `${MCP_PREFIX}${change.name}`;
      if (change.on && list("deny").includes(rule)) next.deny = without(list("deny"), rule);
      if (sources.catalogue.includes(change.name)) {
        next.mcp = change.on
          ? withItem(list("mcp"), change.name)
          : without(list("mcp"), change.name);
      } else {
        next.off_mcp = change.on
          ? without(list("off_mcp"), change.name)
          : withItem(list("off_mcp"), change.name);
      }
    } else if (change.kind === "server-tool") {
      const rule = serverToolRule(change.server, change.name);
      next.deny = change.on ? without(list("deny"), rule) : withItem(list("deny"), rule);
    } else {
      next[change.list] = change.on
        ? withItem(list(change.list), change.rule)
        : without(list(change.list), change.rule);
    }
  }
  const changed: Capabilities = {};
  for (const key of ["tools", "deny_tools", "allow", "deny", "mcp", "off_mcp"] as const) {
    if (JSON.stringify(next[key] ?? []) !== JSON.stringify(caps[key] ?? []))
      // An `undefined` here is a key to take out (the list was folded into `tools`).
      changed[key] = next[key];
  }
  if (next.subagents !== caps.subagents) changed.subagents = next.subagents;
  return changed;
}

/** A short text for each change, for confirmations and history. */
export function describeChanges(changes: ToolChange[]): string[] {
  return changes.map((change) => {
    if (change.kind === "tool") return `${change.on ? "allow" : "block"} ${change.name}`;
    if (change.kind === "server")
      return `${change.on ? "allow" : "block"} MCP server ${change.name}`;
    if (change.kind === "server-tool") {
      return `${change.on ? "allow" : "block"} ${change.name} of MCP server ${change.server}`;
    }
    return `${change.on ? "add" : "remove"} ${change.list} rule ${change.rule}`;
  });
}

/**
 * What a running session has to be refused so that it behaves like `now` although it was
 * started as `before`: tool names, `mcp__<server>` for a whole server and
 * `mcp__<server>__<tool>` for one tool. The session keeps the tools but its hook turns the
 * calls down. Null when the difference cannot be had that way and takes a restart: anything
 * added, a rule with a pattern, or a change to something other than tools, servers and rules.
 */
export function liveBlocks(before: ResolvedSession, now: ResolvedSession): string[] | null {
  const rest = (session: ResolvedSession) =>
    JSON.stringify({
      ...session,
      tools: undefined,
      denyTools: [],
      deny: [],
      mcp: {},
      offMcp: [],
    });
  if (rest(before) !== rest(now)) return null;
  const blocks: string[] = [];
  const added = (was: string[], is: string[]) => is.filter((item) => !was.includes(item));

  if ((before.tools === undefined) !== (now.tools === undefined)) return null;
  if (before.tools && now.tools) {
    if (added(before.tools, now.tools).length > 0) return null;
    blocks.push(...added(now.tools, before.tools));
  }
  // Names taken away outside the list (a tool the session never had, an MCP tool): one more
  // is refused like any other, one fewer gives something back.
  if (added(now.denyTools, before.denyTools).length > 0) return null;
  blocks.push(...added(before.denyTools, now.denyTools));

  if (added(now.deny, before.deny).length > 0) return null;
  const rules = added(before.deny, now.deny);
  // A rule with a pattern, such as Bash(git push *) or mcp__github__*, is matched by the
  // Claude command only.
  if (rules.some((rule) => /[(*]/.test(rule))) return null;
  blocks.push(...rules);

  for (const [name, server] of Object.entries(now.mcp)) {
    if (JSON.stringify(before.mcp[name]) !== JSON.stringify(server)) return null;
  }
  for (const name of Object.keys(before.mcp)) {
    if (!(name in now.mcp)) blocks.push(`${MCP_PREFIX}${name}`);
  }
  const offBefore = before.offMcp ?? [];
  if (added(now.offMcp, offBefore).length > 0) return null;
  blocks.push(...added(offBefore, now.offMcp).map((name) => `${MCP_PREFIX}${name}`));
  return [...new Set(blocks)].sort();
}

/** Whether a call of `tool` is one of the refused ones. */
export function isBlocked(tool: string, blocks: string[]): boolean {
  return blocks.some(
    (block) =>
      block === tool ||
      // A whole server: every one of its tools.
      (block.startsWith(MCP_PREFIX) && tool.startsWith(`${block}__`)),
  );
}

/**
 * Name of the file in a session's run folder that lists the skills its Skill tool may be
 * called with (`ResolvedSession.allowedSkills`), written when the session is started.
 */
export const SKILLS_FILE = "skills.json";

/**
 * What a session is told when it calls the Skill tool for a skill it was not given; null when
 * the call may go ahead. This is what keeps a skill out that dwa does not know by name, such as
 * one a new version of the Claude command brings. `allowed` holds names and `<plugin>:*`.
 */
export function skillRefusal(skill: string, allowed: string[]): string | null {
  const name = skill.replace(/^\//, "");
  const ok = allowed.some((entry) =>
    entry.endsWith(":*") ? name.startsWith(entry.slice(0, -1)) : entry === name,
  );
  if (ok) return null;
  const has = allowed.length > 0 ? `It has: ${allowed.join(", ")}.` : "It has no skills.";
  return `The skill "${name}" is not one this session was given in ${APP_NAME}. ${has} Skills built into the Claude command are off unless the session's role names them (builtin_skills). Do the work without the skill, or report that you need it with the ${APP_NAME} tool report_gap.`;
}

/** Name of the file in a session's run folder that lists what it is refused. */
export const BLOCKED_FILE = "blocked.json";

/** What a session is told when it calls a refused tool; null when the call may go ahead. */
export function blockedReason(tool: string, blocks: string[]): string | null {
  if (!isBlocked(tool, blocks)) return null;
  const server = /^mcp__(.+?)__/.exec(tool)?.[1];
  const what =
    server && blocks.includes(`${MCP_PREFIX}${server}`) ? `The MCP server ${server}` : tool;
  return `${what} was switched off for this session in ${APP_NAME}. Do not try to work around it; say what you could not do.`;
}
