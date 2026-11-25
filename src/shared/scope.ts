// Where a role or a workflow file lives: in the project, or in the user's own dwa folder for
// use in every project. Sessions and runs take the project's file when both have one of a
// name; the editors address a file by its place and name, so the other one stays reachable.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigError } from "./capabilities.ts";
import { BY_HAND, moveHistory, record, type Tracked, trackedItem } from "./history.ts";

type Env = Record<string, string | undefined>;

/** "user" is the personal folder; it is shown as "personal". */
export type Scope = "project" | "user";

/** The project comes first: its files win. */
export const SCOPES: Scope[] = ["project", "user"];

/** One file by place and name. */
export interface ItemRef {
  name: string;
  source: Scope;
}

export interface ItemEntry extends ItemRef {
  path: string;
  /** A personal file the project has one of the same name for, so nothing uses it here. */
  hidden: boolean;
}

export interface ScopeContext {
  projectRoot: string;
  env?: Env;
  /** The file system for listing; tests pass their own. */
  files?: { list(path: string): string[]; exists(path: string): boolean };
}

/** A kind of file kept in both places. */
export interface ItemKind {
  /** Folder name, under the dwa folder and under its history. */
  id: "roles" | "workflows";
  /** The word for one of them in messages. */
  label: string;
  dir(source: Scope, ctx: ScopeContext): string;
  valid(name: string): boolean;
}

export function scopeLabel(source: Scope): "project" | "personal" {
  return source === "user" ? "personal" : "project";
}

/** "personal:name" or "project:name" names one file; a bare name means the one that is used. */
export function parseRef(text: string): { name: string; source?: Scope } {
  const match = /^(personal|project):(.+)$/.exec(text);
  if (!match) return { name: text };
  return { name: match[2] as string, source: match[1] === "personal" ? "user" : "project" };
}

/** The reverse of `parseRef`, always with the place. */
export function formatRef(ref: ItemRef): string {
  return `${scopeLabel(ref.source)}:${ref.name}`;
}

function entryNames(dir: string, ctx: ScopeContext): string[] {
  if (ctx.files) return ctx.files.list(dir);
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** Every file of the kind in both places, by name, the project's before a personal one. */
export function listItems(kind: ItemKind, ctx: ScopeContext): ItemEntry[] {
  const entries: ItemEntry[] = [];
  const inProject = new Set<string>();
  for (const source of SCOPES) {
    const dir = kind.dir(source, ctx);
    for (const file of entryNames(dir, ctx)) {
      if (!file.endsWith(".toml")) continue;
      const name = file.slice(0, -".toml".length);
      if (!kind.valid(name)) continue;
      if (source === "project") inProject.add(name);
      entries.push({
        name,
        source,
        path: join(dir, file),
        hidden: source === "user" && inProject.has(name),
      });
    }
  }
  return entries.sort(
    (a, b) => a.name.localeCompare(b.name) || SCOPES.indexOf(a.source) - SCOPES.indexOf(b.source),
  );
}

export function findItem(kind: ItemKind, ref: ItemRef, ctx: ScopeContext): ItemEntry | null {
  return (
    listItems(kind, ctx).find((entry) => entry.name === ref.name && entry.source === ref.source) ??
    null
  );
}

/** The file a bare name means: the project's, otherwise the personal one. */
export function winner(kind: ItemKind, name: string, ctx: ScopeContext): ItemEntry | null {
  return listItems(kind, ctx).find((entry) => entry.name === name && !entry.hidden) ?? null;
}

/** The entry for a name with or without a place. Throws when there is no such file. */
export function requireItem(
  kind: ItemKind,
  ref: string | { name: string; source?: Scope },
  ctx: ScopeContext,
): ItemEntry {
  const { name, source } = typeof ref === "string" ? { name: ref, source: undefined } : ref;
  const entry = source ? findItem(kind, { name, source }, ctx) : winner(kind, name, ctx);
  if (!entry) {
    const where = source ? `${scopeLabel(source)} ` : "";
    throw new ConfigError(`Unknown ${where}${kind.label} "${name}".`);
  }
  return entry;
}

export function trackedEntry(kind: ItemKind, entry: ItemRef & { path: string }, ctx: ScopeContext) {
  return trackedItem(kind.id, entry, ctx.projectRoot, ctx.env) satisfies Tracked;
}

/**
 * Moves a file to the other place, with its history. Refused when that place already has one
 * of the name. What refers to the name is left alone: the name still means a file.
 */
export function moveItem(kind: ItemKind, ref: ItemRef, to: Scope, ctx: ScopeContext): ItemEntry {
  const entry = requireItem(kind, ref, ctx);
  if (entry.source === to) {
    throw new ConfigError(
      `${kind.label} "${entry.name}" is already ${to === "user" ? "personal" : "in the project"}.`,
    );
  }
  const path = join(kind.dir(to, ctx), `${entry.name}.toml`);
  if (existsSync(path)) {
    throw new ConfigError(
      `There is already a ${scopeLabel(to)} ${kind.label} "${entry.name}"; rename one of them first.`,
    );
  }
  const before = trackedEntry(kind, entry, ctx);
  record(before, BY_HAND);
  mkdirSync(dirname(path), { recursive: true });
  try {
    renameSync(entry.path, path);
  } catch (error) {
    // The home folder and the project can be on different disks, where a rename is refused.
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(entry.path, path);
    rmSync(entry.path);
  }
  const moved: ItemEntry = { name: entry.name, source: to, path, hidden: false };
  moveHistory(before, trackedEntry(kind, moved, ctx));
  return moved;
}
