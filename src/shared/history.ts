// Numbered versions of a role file or of the config. Every change dwa makes, and every change
// made by hand that dwa notices, becomes a version; switching to an older one moves a pointer
// and deletes nothing, so the way back stays open.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { historyDir, projectConfigPath, userConfigPath, userHistoryDir } from "./paths.ts";
import type { RoleEntry } from "./roles.ts";

type Env = Record<string, string | undefined>;

/** A file whose versions are kept, and the directory they are kept in. */
export interface Tracked {
  path: string;
  dir: string;
}

export interface Version {
  /** 1 for the first version; shown as v1. */
  n: number;
  /** ISO time the version was recorded. */
  time: string;
  /** What made it: "first version", "edited by hand", "tools dialog", "role settings", ... */
  source: string;
  hash: string;
  /** The version the file was at when this one was made; absent for the first. */
  from?: number;
}

export interface History {
  /** The version the file has now, or null when nothing was recorded yet. */
  current: number | null;
  versions: Version[];
}

/** Source of a version that dwa found on disk rather than wrote itself. */
export const BY_HAND = "edited by hand";
const FIRST = "first version";

/**
 * A role or workflow file with its history: under the project's history for a project file,
 * under the personal one for a personal file, so the two never share versions.
 */
export function trackedItem(
  kind: "roles" | "workflows",
  entry: { name: string; source: "project" | "user"; path: string },
  projectRoot: string,
  env?: Env,
): Tracked {
  const base = entry.source === "user" ? userHistoryDir(env) : historyDir(projectRoot);
  return { path: entry.path, dir: join(base, kind, entry.name) };
}

export function trackedRole(entry: RoleEntry, projectRoot: string, env?: Env): Tracked {
  return trackedItem("roles", entry, projectRoot, env);
}

/** The project's config, or with "user" the personal one. */
export function trackedConfig(
  projectRoot: string,
  source: "project" | "user" = "project",
  env?: Env,
): Tracked {
  if (source === "user") {
    return { path: userConfigPath(env), dir: join(userHistoryDir(env), "config") };
  }
  return { path: projectConfigPath(projectRoot), dir: join(historyDir(projectRoot), "config") };
}

function indexPath(tracked: Tracked): string {
  return join(tracked.dir, "index.json");
}

function versionPath(tracked: Tracked, n: number): string {
  return join(tracked.dir, `v${n}.toml`);
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function readHistory(tracked: Tracked): History {
  if (existsSync(indexPath(tracked))) {
    try {
      const parsed = JSON.parse(readFileSync(indexPath(tracked), "utf8")) as History;
      if (Array.isArray(parsed.versions)) return parsed;
    } catch {
      // Unreadable: rebuilt below from the version files, which are what must not be lost.
    }
  }
  if (!existsSync(tracked.dir)) return { current: null, versions: [] };
  // No usable index but version files: number on from them, so none is written over.
  const versions = readdirSync(tracked.dir)
    .flatMap((file) => {
      const n = Number(/^v(\d+)\.toml$/.exec(file)?.[1]);
      if (!Number.isInteger(n)) return [];
      const path = join(tracked.dir, file);
      return [
        {
          n,
          time: statSync(path).mtime.toISOString(),
          source: "recovered",
          hash: hashOf(readFileSync(path, "utf8")),
        },
      ];
    })
    .sort((a, b) => a.n - b.n);
  return { current: null, versions };
}

function writeHistory(tracked: Tracked, history: History): void {
  mkdirSync(tracked.dir, { recursive: true });
  writeFileSync(indexPath(tracked), `${JSON.stringify(history, null, 2)}\n`);
}

/** Text of one version. */
export function versionText(tracked: Tracked, n: number): string {
  const path = versionPath(tracked, n);
  if (!existsSync(path)) throw new Error(`There is no version v${n}.`);
  return readFileSync(path, "utf8");
}

/**
 * Looks at the file and brings the history up to date with it. Content that is already the
 * current version changes nothing; content equal to another version moves the pointer there;
 * anything else becomes the next version. Returns the version the file is at, or null when
 * the file does not exist.
 */
export function record(tracked: Tracked, source: string, now: Date = new Date()): Version | null {
  if (!existsSync(tracked.path)) return null;
  const text = readFileSync(tracked.path, "utf8");
  const hash = hashOf(text);
  const history = readHistory(tracked);
  const current = history.versions.find((version) => version.n === history.current);
  if (current?.hash === hash) return current;
  const known = history.versions.findLast((version) => version.hash === hash);
  if (known) {
    writeHistory(tracked, { ...history, current: known.n });
    return known;
  }
  const n = Math.max(0, ...history.versions.map((version) => version.n)) + 1;
  const version: Version = {
    n,
    time: now.toISOString(),
    source: history.versions.length === 0 && source === BY_HAND ? FIRST : source,
    hash,
    ...(history.current !== null ? { from: history.current } : {}),
  };
  mkdirSync(tracked.dir, { recursive: true });
  writeFileSync(versionPath(tracked, n), text);
  writeHistory(tracked, { current: n, versions: [...history.versions, version] });
  return version;
}

/**
 * Writes the file from dwa. What is on disk is recorded first, so a change made by hand since
 * the last look is its own version and is not lost under this one.
 */
export function saveTracked(
  tracked: Tracked,
  text: string,
  source: string,
  now: Date = new Date(),
): Version {
  record(tracked, BY_HAND, now);
  mkdirSync(dirname(tracked.path), { recursive: true });
  writeFileSync(tracked.path, text);
  return record(tracked, source, now) as Version;
}

/** Gives the file the content of an earlier (or later) version and makes that one current. */
export function switchTo(tracked: Tracked, n: number, now: Date = new Date()): Version {
  record(tracked, BY_HAND, now);
  const history = readHistory(tracked);
  const version = history.versions.find((candidate) => candidate.n === n);
  if (!version) throw new Error(`There is no version v${n}.`);
  mkdirSync(dirname(tracked.path), { recursive: true });
  writeFileSync(tracked.path, versionText(tracked, n));
  writeHistory(tracked, { ...readHistory(tracked), current: n });
  return version;
}

/** Moves the history of a renamed file. Nothing happens when there is none yet. */
export function moveHistory(from: Tracked, to: Tracked): void {
  if (!existsSync(from.dir)) return;
  mkdirSync(dirname(to.dir), { recursive: true });
  if (existsSync(to.dir)) {
    // The history of a role of that name that was deleted. It is kept, out of the way.
    let n = 1;
    while (existsSync(`${to.dir}.old-${n}`)) n += 1;
    renameSync(to.dir, `${to.dir}.old-${n}`);
  }
  try {
    renameSync(from.dir, to.dir);
  } catch (error) {
    // Another disk (a personal file moved into a project elsewhere): copied whole, then the
    // original folder goes. Every version keeps its number.
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from.dir, to.dir, { recursive: true });
    rmSync(from.dir, { recursive: true });
  }
}

/**
 * The lines that differ between two texts: `-` for lines only in `a`, `+` for lines only in
 * `b`, with `context` unchanged lines around each change. Empty when the texts are equal.
 */
export function diffLines(a: string, b: string, context = 2): string[] {
  const left = a.split("\n");
  const right = b.split("\n");
  // Longest common subsequence, filled from the end so the walk below reads forwards.
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * width + j] =
        left[i] === right[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
    }
  }
  const lines: { mark: " " | "-" | "+"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      lines.push({ mark: " ", text: left[i] as string });
      i += 1;
      j += 1;
    } else if (
      j >= right.length ||
      (i < left.length &&
        (table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number))
    ) {
      lines.push({ mark: "-", text: left[i] as string });
      i += 1;
    } else {
      lines.push({ mark: "+", text: right[j] as string });
      j += 1;
    }
  }
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.mark === " ") return;
    for (let k = index - context; k <= index + context; k++) keep.add(k);
  });
  const out: string[] = [];
  let previous = -1;
  lines.forEach((line, index) => {
    if (!keep.has(index)) return;
    if (previous !== -1 && index > previous + 1) out.push("  ...");
    out.push(`${line.mark} ${line.text}`);
    previous = index;
  });
  return out;
}

/** A version's time as local date and time to the minute, for lists. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  const two = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}`
  );
}
