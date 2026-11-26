// The role settings' real store, against a scratch project and a scratch personal folder.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../src/cli/init.ts";
import type { RoleStore } from "../src/ui/role-screens.ts";
import { diskRoleStore } from "../src/ui/role-store.ts";

let dir: string;
let env: Record<string, string>;
let store: RoleStore;
const home = (...parts: string[]) => join(dir, "home", "dwa", ...parts);
const projectText = (name: string) =>
  readFileSync(join(dir, ".dwa", "roles", `${name}.toml`), "utf8");
const personalText = (name: string) => readFileSync(home("roles", `${name}.toml`), "utf8");
const places = () => store.list().map((role) => [role.name, role.source, role.hidden]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dwa-role-store-"));
  // A personal folder of its own: the real one is never read or written.
  env = { XDG_CONFIG_HOME: join(dir, "home"), DWA_BUILTIN_DIR: "" };
  initProject(dir, { roles: true });
  mkdirSync(home("roles"), { recursive: true });
  writeFileSync(home("roles", "mine.toml"), 'description = "Mine"\n');
  writeFileSync(home("roles", "explore.toml"), 'description = "My explore"\nmodel = "haiku"\n');
  store = diskRoleStore(dir, null, env);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the role store on disk", () => {
  test("lists both places, with the personal role the project hides", () => {
    expect(places()).toEqual([
      ["designer", "project", false],
      ["developer", "project", false],
      ["explore", "project", false],
      ["explore", "user", true],
      ["main", "project", false],
      ["mine", "user", false],
      ["planner", "project", false],
      ["quick", "project", false],
      ["reviewer", "project", false],
      ["role-author", "project", false],
      ["runner", "project", false],
      ["web-research", "project", false],
      ["workflow-author", "project", false],
    ]);
    const hidden = store.list().find((role) => role.hidden);
    expect(hidden).toEqual({
      name: "explore",
      source: "user",
      hidden: true,
      description: "My explore",
      error: null,
    });
    // A file that is not a role is listed with what is wrong with it.
    writeFileSync(home("roles", "broken.toml"), "tools = 1\n");
    expect(store.list().find((role) => role.name === "broken")).toMatchObject({
      source: "user",
      description: null,
      error: expect.stringContaining("tools"),
    });
  });

  test("opening it records what was edited by hand in both places", () => {
    expect(store.history({ name: "mine", source: "user" }).versions).toHaveLength(1);
    expect(existsSync(home("history", "roles", "explore", "v1.toml"))).toBe(true);
    expect(existsSync(join(dir, ".dwa", "history", "roles", "explore", "v1.toml"))).toBe(true);
  });

  test("creates a role in the place asked for", () => {
    store.create("notes", "Takes notes", "user");
    expect(personalText("notes")).toContain('description = "Takes notes"');
    expect(existsSync(join(dir, ".dwa", "roles", "notes.toml"))).toBe(false);
    store.create("tester", "Runs the tests", "project");
    expect(projectText("tester")).toContain('description = "Runs the tests"');
    expect(places()).toContainEqual(["notes", "user", false]);
    expect(places()).toContainEqual(["tester", "project", false]);
    expect(() => store.create("mine", "", "project")).toThrow(
      'There is already a personal role "mine".',
    );
    expect(() => store.create("reviewer", "", "user")).toThrow(
      'There is already a role "reviewer".',
    );
  });

  test("loads and saves by place; a bare name is the role that is used", () => {
    expect(store.load({ name: "explore", source: "user" })).toEqual({
      description: "My explore",
      model: "haiku",
    });
    expect(store.load("explore").tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(store.load("mine")).toEqual({ description: "Mine" });
    expect(() => store.load({ name: "mine", source: "project" })).toThrow(
      'Unknown project role "mine".',
    );

    const project = projectText("explore");
    expect(store.save({ name: "explore", source: "user" }, { model: "opus", effort: "low" })).toBe(
      2,
    );
    expect(personalText("explore")).toBe(
      'description = "My explore"\nmodel = "opus"\neffort = "low"\n',
    );
    expect(projectText("explore")).toBe(project);
    expect(store.save("explore", { description: "Reads" })).toBe(2);
    expect(personalText("explore")).toContain('description = "My explore"');
    expect(store.load("explore").description).toBe("Reads");
    expect(() =>
      store.save({ name: "mine", source: "user" }, { effort: "huge" as never }),
    ).toThrow();
  });

  test("duplicates across the places, or next to the original", () => {
    store.duplicate({ name: "reviewer", source: "project" }, "critic", "user");
    expect(personalText("critic")).toBe(projectText("reviewer"));
    store.duplicate({ name: "explore", source: "user" }, "scout", "project");
    expect(projectText("scout")).toBe(personalText("explore"));
    store.duplicate({ name: "mine", source: "user" }, "mine2");
    store.duplicate("reviewer", "reviewer2");
    expect(places()).toEqual(
      expect.arrayContaining([
        ["critic", "user", false],
        ["scout", "project", false],
        ["mine2", "user", false],
        ["reviewer2", "project", false],
      ]),
    );
    expect(store.history({ name: "critic", source: "user" }).versions[0]?.source).toBe(
      "copy of reviewer",
    );
  });

  test("moves a role and its history, and refuses when the name is taken there", () => {
    store.save({ name: "mine", source: "user" }, { model: "opus" });
    const text = personalText("mine");
    store.move({ name: "mine", source: "user" }, "project");
    expect(projectText("mine")).toBe(text);
    expect(existsSync(home("roles", "mine.toml"))).toBe(false);
    expect(places()).toContainEqual(["mine", "project", false]);
    const history = store.history({ name: "mine", source: "project" });
    expect(history.versions.map((version) => [version.n, version.source])).toEqual([
      [1, "first version"],
      [2, "role settings"],
    ]);
    expect(history.current).toBe(2);
    expect(existsSync(home("history", "roles", "mine"))).toBe(false);
    expect(() => store.history({ name: "mine", source: "user" })).toThrow(
      'Unknown personal role "mine".',
    );

    store.move("developer", "user");
    expect(places()).toContainEqual(["developer", "user", false]);
    expect(() => store.move({ name: "explore", source: "user" }, "project")).toThrow(
      'There is already a project role "explore"',
    );
    expect(() => store.move("reviewer", "project")).toThrow("already in the project");
  });

  test("renames and removes one place's file", () => {
    store.rename({ name: "explore", source: "user" }, "scout");
    expect(places()).toContainEqual(["scout", "user", false]);
    expect(places()).toContainEqual(["explore", "project", false]);
    expect(store.load("reviewer").extends).toBe("explore");
    expect(store.users("explore")).toContain("role reviewer extends it");
    expect(() => store.remove("explore")).toThrow("still used");
    store.remove({ name: "scout", source: "user" });
    expect(places().map(([name]) => name)).not.toContain("scout");
  });

  test("history, diff and switch work on a personal role's own versions", () => {
    const mine = { name: "mine", source: "user" } as const;
    store.save(mine, { model: "opus" });
    store.save(mine, { model: "haiku" });
    const history = store.history(mine);
    expect(history.current).toBe(3);
    expect(history.versions.map((version) => version.source)).toEqual([
      "first version",
      "role settings",
      "role settings",
    ]);
    expect(store.diff(mine, 2, 3)).toEqual([
      '  description = "Mine"',
      '- model = "opus"',
      '+ model = "haiku"',
      "  ",
    ]);
    expect(store.diff(mine, 3, 3)).toEqual(["No differences."]);
    store.switchTo(mine, 1);
    expect(personalText("mine")).toBe('description = "Mine"\n');
    expect(store.history(mine)).toMatchObject({ current: 1 });
    expect(store.history(mine).versions).toHaveLength(3);
    expect(() => store.switchTo(mine, 9)).toThrow("There is no version v9.");
    // The hidden role has versions of its own, apart from the project's role of the name.
    const hidden = { name: "explore", source: "user" } as const;
    store.save(hidden, { effort: "low" });
    expect(store.history(hidden).versions).toHaveLength(2);
    expect(store.history("explore").versions).toHaveLength(1);
    store.switchTo(hidden, 1);
    expect(personalText("explore")).toBe('description = "My explore"\nmodel = "haiku"\n');
  });

  test("says what a change means outside the project's files", () => {
    expect(store.warnings("delete", { name: "mine", source: "user" })).toEqual([
      'Other projects that use your personal role "mine" are not checked: they will no longer find it.',
    ]);
    expect(store.warnings("delete", "explore")).toEqual([
      'Your personal role "explore" is hidden by this one and will be the one used here afterwards.',
    ]);
    expect(store.warnings("move", "explore")).toEqual([
      'Others who use this project will no longer have role "explore".',
      'Role "designer" is in the project but starts from your personal role "explore", ' +
        "which others who use this project do not have.",
      'Role "planner" is in the project but starts from your personal role "explore", ' +
        "which others who use this project do not have.",
      'Role "reviewer" is in the project but starts from your personal role "explore", ' +
        "which others who use this project do not have.",
    ]);
    expect(store.warnings("save", "reviewer")).toEqual([]);
    store.save("reviewer", { extends: "mine" });
    expect(store.warnings("save", "reviewer")).toEqual([
      'Role "reviewer" is in the project but starts from your personal role "mine", ' +
        "which others who use this project do not have.",
    ]);
    expect(store.users({ name: "mine", source: "user" })).toEqual(["role reviewer extends it"]);
    expect(store.users({ name: "explore", source: "user" })).toEqual([]);
  });

  test("offers the skills of the personal folder with the project's", () => {
    mkdirSync(home("skills", "notes"), { recursive: true });
    writeFileSync(home("skills", "notes", "SKILL.md"), "notes");
    expect(store.choices().skills).toEqual(expect.arrayContaining(["review-checklist", "notes"]));
    expect(store.choices()).toMatchObject({ mcp: [], plugins: [], projectMcp: [] });
  });
});
