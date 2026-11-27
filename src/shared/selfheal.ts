// Self-heal, the parts without a daemon: what a proposal to change a role file or `[defaults]`
// is made of, how its changes are laid over the values a file has, which of them give a session
// more than it had, and the text of a report about dwa itself. Pure: no files, no store.
import {
  ALL_TOOLS,
  CAPABILITY_KEYS,
  type Capabilities,
  ConfigError,
  listedTools,
  NAME_PATTERN,
} from "./capabilities.ts";
import { APP_NAME } from "./constants.ts";
import type { FileTarget } from "./role-edit.ts";

/** The built-in role of the session that looks into a report. */
export const SELFHEAL_ROLE = `${APP_NAME}-selfheal`;

/**
 * Roles whose sessions do not get the report tool: the one that handles reports, and the two
 * that write a role or a workflow for the user, who is right there to be told.
 */
export const NO_REPORT_ROLES: readonly string[] = [SELFHEAL_ROLE, "role-author", "workflow-author"];

/** Keys of a role file that hold a list of names or rules. */
export const LIST_KEYS = [
  "tools",
  "deny_tools",
  "allow",
  "deny",
  "mcp",
  "plugins",
  "skills",
  "off_mcp",
  "off_plugins",
  "off_skills",
  "builtin_skills",
] as const;
export type ListKey = (typeof LIST_KEYS)[number];

/** Keys of a role file that hold one value. The last three are not capability fields. */
export const VALUE_KEYS = [
  "model",
  "effort",
  "permission_mode",
  "memory",
  "subagents",
  "prompt",
  "description",
  "when_to_use",
] as const;
export type ValueKey = (typeof VALUE_KEYS)[number];

/**
 * One change of a proposal: the smallest part the user can switch off by itself. Changes are
 * operations and not whole values, so they still fit when the file changed in the meantime
 * and can be laid over one session as well as written to a file.
 */
export type Change = { id: string; file: FileTarget; why?: string } & (
  | { op: "add" | "remove"; key: ListKey; item: string }
  | { op: "set"; key: ValueKey; value: string | boolean }
  | { op: "unset"; key: ListKey | ValueKey }
);

/** A change as the selfheal session hands it in. */
export interface ChangeInput {
  /** `role:<name>`, `personal-role:<name>`, `defaults` or `personal-defaults`. */
  file?: string;
  key: string;
  add?: string;
  remove?: string;
  set?: string | boolean;
  unset?: boolean;
  why?: string;
}

function isListKey(key: string): key is ListKey {
  return (LIST_KEYS as readonly string[]).includes(key);
}

function isValueKey(key: string): key is ValueKey {
  return (VALUE_KEYS as readonly string[]).includes(key);
}

/** The file a change names, from the short form a selfheal session writes. */
export function parseFile(text: string): FileTarget {
  if (text === "defaults") return { kind: "defaults" };
  if (text === "personal-defaults") return { kind: "defaults", source: "user" };
  const [place, name, ...rest] = text.split(":");
  if (rest.length === 0 && name && NAME_PATTERN.test(name)) {
    if (place === "role") return { kind: "role", name };
    if (place === "personal-role") return { kind: "role", name, source: "user" };
  }
  throw new ConfigError(
    `"${text}" is not a file a change can name: use role:<name>, personal-role:<name>, defaults or personal-defaults.`,
  );
}

/** The short form of a file, as `parseFile` reads it. */
export function formatFile(file: FileTarget): string {
  if (file.kind === "defaults") return file.source === "user" ? "personal-defaults" : "defaults";
  return `${file.source === "user" ? "personal-role" : "role"}:${file.name}`;
}

/**
 * Checks the changes a selfheal session handed in and gives each an id. `fallback` is the file
 * of a change that names none. Throws `ConfigError` with what is wrong with which change.
 */
export function expandChanges(inputs: ChangeInput[], fallback: FileTarget): Change[] {
  if (inputs.length === 0) throw new ConfigError("A proposal needs at least one change.");
  return inputs.map((input, index) => {
    const where = `Change ${index + 1} (${input.key})`;
    const file = input.file ? parseFile(input.file) : fallback;
    const base = { id: `c${index + 1}`, file, ...(input.why ? { why: input.why } : {}) };
    const given = [
      input.add !== undefined,
      input.remove !== undefined,
      input.set !== undefined,
      input.unset === true,
    ].filter(Boolean).length;
    if (given !== 1) {
      throw new ConfigError(`${where}: give exactly one of add, remove, set and unset.`);
    }
    const { key } = input;
    if (!isListKey(key) && !isValueKey(key)) {
      throw new ConfigError(
        `${where}: unknown key. Lists: ${LIST_KEYS.join(", ")}. Single values: ${VALUE_KEYS.join(", ")}.`,
      );
    }
    if (file.kind === "defaults" && !(CAPABILITY_KEYS as string[]).includes(key)) {
      throw new ConfigError(`${where}: [defaults] cannot hold ${key}; it belongs in a role file.`);
    }
    if (input.unset === true) return { ...base, op: "unset" as const, key };
    if (input.add !== undefined || input.remove !== undefined) {
      const item = input.add ?? input.remove ?? "";
      if (!isListKey(key)) throw new ConfigError(`${where}: ${key} is one value; use set.`);
      if (item === "") throw new ConfigError(`${where}: the item is empty.`);
      return {
        ...base,
        op: input.add !== undefined ? ("add" as const) : ("remove" as const),
        key,
        item,
      };
    }
    if (!isValueKey(key)) throw new ConfigError(`${where}: ${key} is a list; use add or remove.`);
    const value = input.set as string | boolean;
    const wantsFlag = key === "memory" || key === "subagents";
    if (wantsFlag !== (typeof value === "boolean")) {
      throw new ConfigError(
        `${where}: ${wantsFlag ? "set takes true or false" : "set takes a text"}.`,
      );
    }
    return { ...base, op: "set" as const, key, value };
  });
}

function withItem(list: string[], item: string): string[] {
  return list.includes(item) ? list : [...list, item];
}

function without(list: string[], item: string): string[] {
  return list.filter((entry) => entry !== item);
}

/** What `valuesAfter` needs to know besides the values themselves. */
export interface ValueContext {
  /**
   * The names of the project's own skills: what a session has without a `skills` list, so a
   * list that is first written has to start from them.
   */
  projectSkills?: string[];
}

/**
 * The values of a file's keys once `changes` are applied to `base`: only the keys that end up
 * different, each with its whole new value, and `null` for a key to take out. `base` is what
 * the file's layer amounts to (a role with its parents and the defaults under it, or the
 * `[defaults]` of one file), so that a list written for the first time starts from what the
 * session had and not from nothing.
 */
export function valuesAfter(
  base: Record<string, unknown>,
  changes: Change[],
  context: ValueContext = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = structuredClone(base);
  const list = (key: ListKey): string[] => (next[key] as string[] | undefined) ?? [];
  for (const change of changes) {
    if (change.op === "set") next[change.key] = change.value;
    else if (change.op === "unset") delete next[change.key];
    else if (change.key === "tools") {
      const caps = next as Capabilities;
      const listed = listedTools(caps);
      if (change.op === "add") {
        if (change.item === ALL_TOOLS) next.tools = [ALL_TOOLS];
        else if (listed === null || listed.includes(change.item)) {
          // It is in the list and was taken away further down: give it back there.
          if (caps.deny_tools) next.deny_tools = without(caps.deny_tools, change.item);
        } else {
          // One file holds either list, so what was taken away is folded into the new list.
          next.tools = [
            ...listed.filter((name) => !(caps.deny_tools ?? []).includes(name)),
            change.item,
          ];
          delete next.deny_tools;
        }
      } else if (caps.tools && listed !== null) next.tools = without(caps.tools, change.item);
      else next.deny_tools = withItem(list("deny_tools"), change.item);
    } else if (change.key === "skills" && next.skills === undefined) {
      // Without a list a session has every project skill; a list must not lose them.
      const all = context.projectSkills ?? [];
      next.skills = change.op === "add" ? withItem(all, change.item) : without(all, change.item);
    } else {
      next[change.key] =
        change.op === "add"
          ? withItem(list(change.key), change.item)
          : without(list(change.key), change.item);
    }
  }
  const changed: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (JSON.stringify(next[key]) === JSON.stringify(base[key])) continue;
    const value = next[key];
    // An empty list that was not there before says nothing new.
    if (Array.isArray(value) && value.length === 0 && base[key] === undefined) continue;
    changed[key] = value === undefined ? null : value;
  }
  return changed;
}

/** Whether every change is one a single session can be given without touching a file. */
export function sessionOnlyPossible(changes: Change[]): boolean {
  return changes.every((change) => (CAPABILITY_KEYS as string[]).includes(change.key));
}

/** Lists that give a session more when they grow, and those that do when they shrink. */
const GROWS: readonly ListKey[] = ["tools", "allow", "mcp", "plugins", "skills", "builtin_skills"];
const SHRINKS: readonly ListKey[] = ["deny_tools", "deny", "off_mcp", "off_plugins", "off_skills"];

/** Whether a change gives a session something it did not have. */
export function widens(change: Change): boolean {
  if (change.op === "add") return GROWS.includes(change.key);
  if (change.op === "remove") return SHRINKS.includes(change.key);
  if (change.op === "unset") return (SHRINKS as readonly string[]).includes(change.key);
  if (change.key === "permission_mode") return true;
  return (change.key === "memory" || change.key === "subagents") && change.value === true;
}

/** What the user is warned of before approving a change that reaches far; null for the rest. */
export function warningOf(change: Change): string | null {
  if (change.op === "add" && change.key === "tools" && change.item === ALL_TOOLS) {
    return "every built-in tool of the Claude command, also those a later version adds";
  }
  if (change.op !== "set") return null;
  if (change.key === "permission_mode" && change.value === "bypassPermissions") {
    return "the session runs everything without asking and without rules";
  }
  if (change.key === "permission_mode" && change.value === "auto") {
    return "the Claude command decides by itself what runs without asking";
  }
  if (change.key === "memory" && change.value === true) {
    return "the session reads and writes your own Claude memory for this project";
  }
  if (change.key === "subagents" && change.value === true) {
    return `the session starts subagents of its own, which ${APP_NAME} does not show`;
  }
  return null;
}

/** One change in one line, as the approval and the feed show it. */
export function describeChange(change: Change): string {
  if (change.op === "set") {
    const { value } = change;
    if (typeof value === "string" && (value.includes("\n") || value.length > 60)) {
      return `${change.key} rewritten (${value.split("\n").length} lines)`;
    }
    return `${change.key} = ${JSON.stringify(value)}`;
  }
  if (change.op === "unset") return `${change.key} removed`;
  return `${change.key} ${change.op === "add" ? "+" : "-"} ${change.item}`;
}

/** Keys whose values are credentials more often than not. */
const SECRET_HOLDERS = ["env", "headers"];

/** A copy with the values under `env` and `headers` replaced, for anything shown or written out. */
export function maskSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item)) as T;
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] =
      SECRET_HOLDERS.includes(key) && typeof inner === "object" && inner !== null
        ? Object.fromEntries(Object.keys(inner).map((name) => [name, "***"]))
        : maskSecrets(inner);
  }
  return out as T;
}

/** A file name part made of a title: lower case, digits and dashes. */
export function slug(title: string): string {
  const made = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return made || "report";
}

/** What a report about dwa itself says. */
export interface BugReport {
  title: string;
  what: string;
  steps: string;
  expected?: string;
  /** Who reported the gap that led here, and in their words. */
  reports: { reporter: string; role: string; what: string; tried?: string }[];
  /** The setup of the sessions concerned, already without secrets. */
  setup: string;
  version: string;
  at: Date;
}

/** The Markdown file of a report about dwa itself. */
export function bugReportText(report: BugReport): string {
  const lines = [
    `# ${report.title}`,
    "",
    `Written by ${SELFHEAL_ROLE} on ${report.at.toISOString().slice(0, 10)}, ${APP_NAME} ${report.version}.`,
    "",
    "## What happened",
    "",
    report.what.trim(),
    "",
  ];
  if (report.expected?.trim()) lines.push("## What was expected", "", report.expected.trim(), "");
  lines.push("## Steps to repeat", "", report.steps.trim(), "", "## Reported by", "");
  for (const item of report.reports) {
    lines.push(`- ${item.reporter} (role ${item.role || "none"}): ${item.what.trim()}`);
    if (item.tried?.trim()) lines.push(`  Tried: ${item.tried.trim()}`);
  }
  lines.push("", "## Setup", "", "```", report.setup.trim(), "```", "");
  return lines.join("\n");
}

/** A run of lines that differ between two texts: what goes at line `at` of the first, and what comes. */
export interface Hunk {
  index: number;
  /** The line of the first text the hunk starts at, from 0. */
  at: number;
  remove: string[];
  add: string[];
}

/** The runs of lines in which `after` differs from `before`, in order. */
export function textHunks(before: string, after: string): Hunk[] {
  const left = before.split("\n");
  const right = after.split("\n");
  // Longest common subsequence, filled from the end so the walk below reads forwards.
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * width + j] =
        left[i] === right[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const hunks: Hunk[] = [];
  let open: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      open = null;
      i++;
      j++;
      continue;
    }
    if (!open) {
      open = { index: hunks.length, at: i, remove: [], add: [] };
      hunks.push(open);
    }
    const down = i < left.length ? (table[(i + 1) * width + j] ?? 0) : -1;
    const across = j < right.length ? (table[i * width + j + 1] ?? 0) : -1;
    if (down >= across) open.remove.push(left[i++] as string);
    else open.add.push(right[j++] as string);
  }
  return hunks;
}

/** `before` with the hunks that lead to `after`, except the ones named in `dropped`. */
export function withoutHunks(before: string, after: string, dropped: number[]): string {
  if (dropped.length === 0) return after;
  const left = before.split("\n");
  const out: string[] = [];
  let at = 0;
  for (const hunk of textHunks(before, after)) {
    out.push(...left.slice(at, hunk.at));
    if (dropped.includes(hunk.index)) out.push(...hunk.remove);
    else out.push(...hunk.add);
    at = hunk.at + hunk.remove.length;
  }
  out.push(...left.slice(at));
  return out.join("\n");
}

/** The id of one hunk of a change to a text, as the approval's switches name it. */
export function hunkId(changeId: string, index: number): string {
  return `${changeId}#${index}`;
}

/**
 * The changes that are left when the user switched some off. `dropped` holds change ids and,
 * for a change to the prompt, ids of single hunks (`hunkId`); `prompt` is the text the hunks
 * are worked out against. A prompt change whose hunks are all off is left out.
 */
export function keptChanges(changes: Change[], dropped: string[], prompt: string): Change[] {
  const kept: Change[] = [];
  for (const change of changes) {
    if (dropped.includes(change.id)) continue;
    if (change.op === "set" && change.key === "prompt" && typeof change.value === "string") {
      const hunks = textHunks(prompt, change.value);
      const off = hunks
        .filter((hunk) => dropped.includes(hunkId(change.id, hunk.index)))
        .map((hunk) => hunk.index);
      if (off.length > 0 && off.length === hunks.length) continue;
      kept.push({ ...change, value: withoutHunks(prompt, change.value, off) });
      continue;
    }
    kept.push(change);
  }
  return kept;
}
