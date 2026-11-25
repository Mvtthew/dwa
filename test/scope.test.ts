// Files kept in two places, the project and the personal folder: listing them, naming one,
// and moving one across with its history. Role files stand in for the kind.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHistory, saveTracked, versionText } from "../src/shared/history.ts";
import { roleKind } from "../src/shared/roles.ts";
import {
  findItem,
  formatRef,
  listItems,
  moveItem,
  parseRef,
  requireItem,
  type Scope,
  type ScopeContext,
  scopeLabel,
  trackedEntry,
  winner,
} from "../src/shared/scope.ts";

let dir: string;
let ctx: ScopeContext;
const place = (source: Scope) =>
  source === "user" ? join(dir, "home", "dwa", "roles") : join(dir, ".dwa", "roles");
const historyOf = (source: Scope, name: string) =>
  source === "user"
    ? join(dir, "home", "dwa", "history", "roles", name)
    : join(dir, ".dwa", "history", "roles", name);
function put(source: Scope, file: string, text = ""): string {
  mkdirSync(place(source), { recursive: true });
  writeFileSync(join(place(source), file), text);
  return join(place(source), file);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dwa-scope-"));
  // A personal folder of its own: the real one is never read or written.
  ctx = { projectRoot: dir, env: { XDG_CONFIG_HOME: join(dir, "home") } };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("listing", () => {
  test("lists both places by name, the project's first, and marks a personal twin hidden", () => {
    put("project", "reviewer.toml");
    put("project", "explore.toml");
    put("user", "reviewer.toml");
    put("user", "mine.toml");
    put("user", "alpha.toml");
    expect(listItems(roleKind, ctx)).toEqual([
      { name: "alpha", source: "user", path: join(place("user"), "alpha.toml"), hidden: false },
      {
        name: "explore",
        source: "project",
        path: join(place("project"), "explore.toml"),
        hidden: false,
      },
      { name: "mine", source: "user", path: join(place("user"), "mine.toml"), hidden: false },
      {
        name: "reviewer",
        source: "project",
        path: join(place("project"), "reviewer.toml"),
        hidden: false,
      },
      {
        name: "reviewer",
        source: "user",
        path: join(place("user"), "reviewer.toml"),
        hidden: true,
      },
    ]);
  });

  test("skips what is not a file of the kind and places that do not exist", () => {
    expect(listItems(roleKind, ctx)).toEqual([]);
    put("project", "good.toml");
    put("project", "a b.toml");
    put("project", "notes.md");
    put("project", ".toml");
    put("user", "bad name.toml");
    expect(listItems(roleKind, ctx).map((entry) => entry.name)).toEqual(["good"]);
  });

  test("reads through the given file system instead of the disk", () => {
    put("project", "on-disk.toml");
    const files = {
      list: (path: string) => (path === place("user") ? ["virtual.toml"] : []),
      exists: () => true,
    };
    expect(
      listItems(roleKind, { ...ctx, files }).map((entry) => [entry.name, entry.source]),
    ).toEqual([["virtual", "user"]]);
  });
});

describe("naming one file", () => {
  beforeEach(() => {
    put("project", "reviewer.toml");
    put("user", "reviewer.toml");
    put("user", "mine.toml");
  });

  test("findItem takes the place literally; winner is the file a bare name means", () => {
    expect(findItem(roleKind, { name: "reviewer", source: "user" }, ctx)).toMatchObject({
      source: "user",
      hidden: true,
    });
    expect(findItem(roleKind, { name: "reviewer", source: "project" }, ctx)).toMatchObject({
      source: "project",
      hidden: false,
    });
    expect(findItem(roleKind, { name: "mine", source: "project" }, ctx)).toBeNull();
    expect(winner(roleKind, "reviewer", ctx)?.source).toBe("project");
    expect(winner(roleKind, "mine", ctx)?.source).toBe("user");
    expect(winner(roleKind, "nobody", ctx)).toBeNull();
  });

  test("requireItem resolves a name with or without a place, and says what is missing", () => {
    expect(requireItem(roleKind, "reviewer", ctx).source).toBe("project");
    expect(requireItem(roleKind, { name: "reviewer" }, ctx).source).toBe("project");
    expect(requireItem(roleKind, { name: "reviewer", source: "user" }, ctx).path).toBe(
      join(place("user"), "reviewer.toml"),
    );
    expect(requireItem(roleKind, "mine", ctx).source).toBe("user");
    expect(() => requireItem(roleKind, "nobody", ctx)).toThrow('Unknown role "nobody".');
    expect(() => requireItem(roleKind, { name: "nobody", source: "user" }, ctx)).toThrow(
      'Unknown personal role "nobody".',
    );
    expect(() => requireItem(roleKind, { name: "mine", source: "project" }, ctx)).toThrow(
      'Unknown project role "mine".',
    );
  });

  test("a reference is written as place:name and read back", () => {
    expect(parseRef("reviewer")).toEqual({ name: "reviewer" });
    expect(parseRef("personal:reviewer")).toEqual({ name: "reviewer", source: "user" });
    expect(parseRef("project:reviewer")).toEqual({ name: "reviewer", source: "project" });
    // Only the two places are a prefix; anything else is part of the name.
    expect(parseRef("user:reviewer")).toEqual({ name: "user:reviewer" });
    expect(parseRef("personal:")).toEqual({ name: "personal:" });
    expect(formatRef({ name: "reviewer", source: "user" })).toBe("personal:reviewer");
    expect(formatRef({ name: "reviewer", source: "project" })).toBe("project:reviewer");
    for (const source of ["project", "user"] as const) {
      expect(parseRef(formatRef({ name: "a.b-c", source }))).toEqual({ name: "a.b-c", source });
    }
    expect([scopeLabel("project"), scopeLabel("user")]).toEqual(["project", "personal"]);
  });
});

describe("moving to the other place", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 25, 12, minute));
  /** A file with two versions in the place's own history. */
  function withHistory(source: Scope, name: string): void {
    const path = join(place(source), `${name}.toml`);
    const tracked = trackedEntry(roleKind, { name, source, path }, ctx);
    saveTracked(tracked, 'model = "opus"\n', "role settings", at(0));
    saveTracked(tracked, 'model = "haiku"\n', "tools dialog", at(1));
  }
  const versions = (source: Scope, name: string) => {
    const path = join(place(source), `${name}.toml`);
    const tracked = trackedEntry(roleKind, { name, source, path }, ctx);
    const history = readHistory(tracked);
    return {
      current: history.current,
      list: history.versions.map((version) => [version.n, version.source, version.time]),
      texts: history.versions.map((version) => versionText(tracked, version.n)),
    };
  };

  test("a project file goes to the personal folder and its versions keep their numbers", () => {
    withHistory("project", "reviewer");
    const before = versions("project", "reviewer");
    expect(before.list.map(([n]) => n)).toEqual([1, 2]);

    const moved = moveItem(roleKind, { name: "reviewer", source: "project" }, "user", ctx);
    expect(moved).toEqual({
      name: "reviewer",
      source: "user",
      path: join(place("user"), "reviewer.toml"),
      hidden: false,
    });
    expect(existsSync(join(place("project"), "reviewer.toml"))).toBe(false);
    expect(readFileSync(moved.path, "utf8")).toBe('model = "haiku"\n');
    expect(existsSync(historyOf("project", "reviewer"))).toBe(false);
    expect(existsSync(join(historyOf("user", "reviewer"), "v2.toml"))).toBe(true);
    expect(versions("user", "reviewer")).toEqual(before);
    expect(listItems(roleKind, ctx).map((entry) => [entry.name, entry.source])).toEqual([
      ["reviewer", "user"],
    ]);
  });

  test("a personal file goes into the project the same way, and back again", () => {
    withHistory("user", "mine");
    const before = versions("user", "mine");
    const moved = moveItem(roleKind, { name: "mine", source: "user" }, "project", ctx);
    expect(moved.path).toBe(join(place("project"), "mine.toml"));
    expect(existsSync(join(place("user"), "mine.toml"))).toBe(false);
    expect(existsSync(historyOf("user", "mine"))).toBe(false);
    expect(versions("project", "mine")).toEqual(before);

    moveItem(roleKind, moved, "user", ctx);
    expect(versions("user", "mine")).toEqual(before);
    expect(existsSync(historyOf("project", "mine"))).toBe(false);
  });

  test("a change made by hand before the move is recorded, and a file without history gets one", () => {
    withHistory("project", "reviewer");
    writeFileSync(join(place("project"), "reviewer.toml"), 'model = "sonnet"\n');
    moveItem(roleKind, { name: "reviewer", source: "project" }, "user", ctx);
    const after = versions("user", "reviewer");
    expect(after.list.map(([n, source]) => [n, source])).toEqual([
      [1, "role settings"],
      [2, "tools dialog"],
      [3, "edited by hand"],
    ]);
    expect(after.current).toBe(3);

    put("user", "plain.toml", 'effort = "low"\n');
    moveItem(roleKind, { name: "plain", source: "user" }, "project", ctx);
    expect(versions("project", "plain").list.map(([n, source]) => [n, source])).toEqual([
      [1, "first version"],
    ]);
  });

  test("is refused when the other place has the name, and when the file is already there", () => {
    withHistory("project", "reviewer");
    const hidden = put("user", "reviewer.toml", "# personal\n");
    expect(() => moveItem(roleKind, { name: "reviewer", source: "project" }, "user", ctx)).toThrow(
      'There is already a personal role "reviewer"; rename one of them first.',
    );
    expect(() => moveItem(roleKind, { name: "reviewer", source: "user" }, "project", ctx)).toThrow(
      'There is already a project role "reviewer"; rename one of them first.',
    );
    expect(() =>
      moveItem(roleKind, { name: "reviewer", source: "project" }, "project", ctx),
    ).toThrow('role "reviewer" is already in the project.');
    expect(() => moveItem(roleKind, { name: "reviewer", source: "user" }, "user", ctx)).toThrow(
      'role "reviewer" is already personal.',
    );
    expect(() => moveItem(roleKind, { name: "nobody", source: "user" }, "project", ctx)).toThrow(
      'Unknown personal role "nobody".',
    );
    // Nothing moved.
    expect(readFileSync(hidden, "utf8")).toBe("# personal\n");
    expect(readFileSync(join(place("project"), "reviewer.toml"), "utf8")).toBe('model = "haiku"\n');
    expect(versions("project", "reviewer").list.map(([n]) => n)).toEqual([1, 2]);
  });
});
