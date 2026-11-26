import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../src/cli/init.ts";
import { loadConfig } from "../src/shared/config.ts";
import { readHistory, trackedConfig, versionText } from "../src/shared/history.ts";
import {
  checkRoleText,
  createRole,
  deleteRole,
  describeTarget,
  duplicateRole,
  moveRole,
  noticeEdits,
  originTarget,
  renameRole,
  roleHistory,
  roleTemplate,
  roleUsers,
  saveRoleText,
  saveValues,
  scopeWarnings,
} from "../src/shared/role-edit.ts";
import {
  findRole,
  findRoleIn,
  listAllRoles,
  PERSONAL_DEFAULTS,
  type RoleContext,
  resolveSession,
} from "../src/shared/roles.ts";
import { loadWorkflow } from "../src/shared/workflow.ts";

let dir: string;
let ctx: RoleContext;
const roleText = (name: string) => readFileSync(join(dir, ".dwa", "roles", `${name}.toml`), "utf8");
const configText = () => readFileSync(join(dir, ".dwa", "config.toml"), "utf8");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dwa-role-edit-"));
  // A personal folder of its own, so the roles of whoever runs the tests stay out.
  ctx = { projectRoot: dir, env: { XDG_CONFIG_HOME: join(dir, "home"), DWA_BUILTIN_DIR: "" } };
  initProject(dir, { roles: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("saveValues", () => {
  test("changes a role file in place and records the versions", () => {
    const before = roleText("explore");
    saveValues({ kind: "role", name: "explore" }, { tools: ["Read", "Grep"] }, "tools dialog", ctx);
    expect(roleText("explore")).toBe(
      before.replace('tools = ["Read", "Grep", "Glob", "Bash"]', 'tools = ["Read", "Grep"]'),
    );
    const history = roleHistory("explore", ctx);
    expect(readHistory(history).versions.map((v) => v.source)).toEqual([
      "first version",
      "tools dialog",
    ]);
    expect(versionText(history, 1)).toBe(before);
  });

  test("a role that gets one tool list loses the other, and null removes a key", () => {
    saveValues({ kind: "role", name: "explore" }, { deny_tools: ["Edit"] }, "tools dialog", ctx);
    const role = findRole("explore", ctx)?.role;
    expect(role?.tools).toBeUndefined();
    expect(role?.deny_tools).toEqual(["Edit"]);
    saveValues({ kind: "role", name: "explore" }, { deny_tools: null, memory: null }, "x", ctx);
    expect(findRole("explore", ctx)?.role.deny_tools).toBeUndefined();
  });

  test("writes into [defaults] of the config and keeps the rest of it", () => {
    const before = configText();
    saveValues(
      { kind: "defaults" },
      { deny_tools: ["WebFetch"], model: "haiku" },
      "tools dialog",
      ctx,
    );
    const after = configText();
    expect(after).toContain(
      '[defaults]\nmodel = "haiku"\neffort = "medium"\ndeny_tools = ["WebFetch"]\n',
    );
    expect(after.split("\n").filter((line) => line.startsWith("#"))).toEqual(
      before.split("\n").filter((line) => line.startsWith("#")),
    );
    expect(() => saveValues({ kind: "defaults" }, { prompt: "x" }, "x", ctx)).toThrow(
      "cannot hold",
    );
  });

  test("refuses values that would make the file invalid and writes nothing", () => {
    const before = roleText("reviewer");
    expect(() =>
      saveValues({ kind: "role", name: "reviewer" }, { effort: "huge" as never }, "x", ctx),
    ).toThrow();
    expect(() =>
      saveValues({ kind: "role", name: "explore" }, { extends: "reviewer" }, "x", ctx),
    ).toThrow("loop");
    expect(() =>
      saveValues({ kind: "role", name: "explore" }, { extends: "nobody" }, "x", ctx),
    ).toThrow('no role "nobody"');
    expect(roleText("reviewer")).toBe(before);
    expect(() => saveValues({ kind: "role", name: "nobody" }, {}, "x", ctx)).toThrow(
      "Unknown role",
    );
  });

  test("maps an origin to the file it is written in", () => {
    expect(originTarget("defaults")).toEqual({ kind: "defaults" });
    expect(originTarget("role explore")).toEqual({ kind: "role", name: "explore" });
    expect(originTarget("agent")).toBeNull();
    expect(originTarget(undefined)).toBeNull();
  });
});

describe("roles as files", () => {
  test("creates, duplicates and refuses names that are taken or unusable", () => {
    createRole("tester", roleTemplate("Runs the tests"), "role settings", ctx);
    expect(findRole("tester", ctx)?.role.description).toBe("Runs the tests");
    duplicateRole("reviewer", "critic", ctx);
    expect(roleText("critic")).toBe(roleText("reviewer"));
    expect(readHistory(roleHistory("critic", ctx)).versions[0]?.source).toBe("copy of reviewer");
    expect(() => duplicateRole("reviewer", "critic", ctx)).toThrow("already a role");
    expect(() => createRole("a b", "", "x", ctx)).toThrow("cannot be a role name");
    expect(() => createRole("broken", "tools = 1\n", "x", ctx)).toThrow();
  });

  test("a whole text replaces a role file as given, when it is a role that could start", async () => {
    const text =
      '# kept\ndescription = "Reads more"\nextends = "explore"\n\nprompt = """\nRead.\n"""\n';
    expect(() => createRole("deep", 'extends = "nobody"\n', "x", ctx)).toThrow(
      'there is no role "nobody" to extend',
    );
    createRole("deep", text, "agent a", ctx);
    const next = text.replace("Reads more", "Reads everything");
    expect(saveRoleText("deep", next, "agent a", ctx).n).toBe(2);
    expect(roleText("deep")).toBe(next);
    expect(readHistory(roleHistory("deep", ctx)).versions.map((version) => version.source)).toEqual(
      ["agent a", "agent a"],
    );
    expect(() => saveRoleText("deep", "tools = 1\n", "agent a", ctx)).toThrow();
    expect(() => saveRoleText("deep", 'extends = "deep"\n', "agent a", ctx)).toThrow("loop");
    expect(() => saveRoleText("nobody", text, "agent a", ctx)).toThrow("Unknown role");
    expect(roleText("deep")).toBe(next);

    // The check works on a text that is not a file yet, by the rules of a session start.
    const config = await loadConfig(dir, ctx.env);
    const ref = { name: "fresh", source: "project" as const };
    expect(checkRoleText(ref, text, config, ctx).extends).toBe("explore");
    expect(() => checkRoleText(ref, 'mcp = ["jira"]\n', config, ctx)).toThrow(
      'unknown MCP server "jira"',
    );
    expect(() => checkRoleText(ref, 'skills = ["nothing"]\n', config, ctx)).toThrow(
      'unknown skill "nothing"',
    );
    expect(() => checkRoleText(ref, 'extends = "fresh"\n', config, ctx)).toThrow("loop");
    expect(existsSync(join(dir, ".dwa", "roles", "fresh.toml"))).toBe(false);
  });

  test("lists what uses a role and refuses to delete it meanwhile", () => {
    writeFileSync(
      join(dir, ".dwa", "config.toml"),
      '[main]\nrole = "main"\n\n[[agents]]\nname = "r"\nrole = "explore"\n',
    );
    expect(roleUsers("explore", ctx)).toEqual([
      "role reviewer extends it",
      "[[agents]] in config.toml",
      "workflow bugfix, step diagnose",
      "workflow feature, step explore",
      "workflow parallel-build, step explore",
    ]);
    expect(roleUsers("main", ctx)).toEqual(["the main session ([main] in config.toml)"]);
    expect(() => deleteRole("explore", ctx)).toThrow("still used");

    createRole("spare", roleTemplate("x"), "role settings", ctx);
    deleteRole("spare", ctx);
    expect(findRole("spare", ctx)).toBeNull();
    // The history outlives the file.
    expect(existsSync(join(dir, ".dwa", "history", "roles", "spare", "v1.toml"))).toBe(true);
  });

  test("renames a role everywhere it is named, history included", async () => {
    writeFileSync(
      join(dir, ".dwa", "config.toml"),
      '# mine\n[[agents]]\nname = "r"\nrole = "explore" # reads\n',
    );
    noticeEdits(ctx);
    renameRole("explore", "scout", ctx);
    expect(findRole("explore", ctx)).toBeNull();
    expect(findRole("reviewer", ctx)?.role.extends).toBe("scout");
    expect(configText()).toBe('# mine\n[[agents]]\nname = "r"\nrole = "scout" # reads\n');
    const steps = Object.values(loadWorkflow(dir, "feature").steps).map((step) => step.role);
    expect(steps).toContain("scout");
    expect(steps).not.toContain("explore");
    expect(readHistory(roleHistory("scout", ctx)).versions).toHaveLength(1);
    expect(existsSync(join(dir, ".dwa", "history", "roles", "explore"))).toBe(false);
    const config = await loadConfig(dir, ctx.env);
    expect(resolveSession({ config, role: "reviewer" }, ctx).tools).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash",
    ]);
  });

  test("a rename records a version of the workflow file it changes", () => {
    const path = join(dir, ".dwa", "workflows", "feature.toml");
    const history = join(dir, ".dwa", "history", "workflows", "feature");
    const before = readFileSync(path, "utf8");
    // The file was never looked at before: what it said is kept as the first version.
    expect(existsSync(history)).toBe(false);
    renameRole("explore", "scout", ctx);
    const after = readFileSync(path, "utf8");
    expect(after).toBe(before.replace('role = "explore"', 'role = "scout"'));
    expect(readFileSync(join(history, "v1.toml"), "utf8")).toBe(before);
    expect(readFileSync(join(history, "v2.toml"), "utf8")).toBe(after);
    const index = JSON.parse(readFileSync(join(history, "index.json"), "utf8")) as {
      current: number;
      versions: { n: number; source: string; from?: number }[];
    };
    expect(index.current).toBe(2);
    expect(index.versions.map((version) => [version.n, version.source, version.from])).toEqual([
      [1, "first version", undefined],
      [2, "role explore renamed to scout", 1],
    ]);
    // A role no workflow names leaves the workflow and its history as they are.
    renameRole("main", "lead", ctx);
    expect(readFileSync(path, "utf8")).toBe(after);
    expect(existsSync(join(history, "v3.toml"))).toBe(false);
  });

  test("renames onto the name of a deleted role, whose history is kept aside", () => {
    createRole("spare", roleTemplate("old"), "role settings", ctx);
    deleteRole("spare", ctx);
    createRole("other", roleTemplate("new"), "role settings", ctx);
    renameRole("other", "spare", ctx);
    expect(findRole("spare", ctx)?.role.description).toBe("new");
    expect(versionText(roleHistory("spare", ctx), 1)).toContain('"new"');
    expect(
      readFileSync(join(dir, ".dwa", "history", "roles", "spare.old-1", "v1.toml"), "utf8"),
    ).toContain('"old"');
  });

  test("notices a file changed by hand and personal roles keep their history at home", () => {
    noticeEdits(ctx);
    writeFileSync(join(dir, ".dwa", "roles", "main.toml"), `${roleText("main")}# a note\n`);
    noticeEdits(ctx);
    noticeEdits(ctx);
    expect(readHistory(roleHistory("main", ctx)).versions.map((v) => v.source)).toEqual([
      "first version",
      "edited by hand",
    ]);
    mkdirSync(join(dir, "home", "dwa", "roles"), { recursive: true });
    createRole("mine", roleTemplate("Personal"), "role settings", ctx, { personal: true });
    expect(existsSync(join(dir, "home", "dwa", "history", "roles", "mine", "v1.toml"))).toBe(true);
    expect(findRole("mine", ctx)?.source).toBe("user");
  });
});

describe("roles in the project and in the personal folder", () => {
  const home = (...parts: string[]) => join(dir, "home", "dwa", ...parts);
  const personalText = (name: string) => readFileSync(home("roles", `${name}.toml`), "utf8");
  const workflowText = () => readFileSync(join(dir, ".dwa", "workflows", "feature.toml"), "utf8");
  /** A personal role file written as an editor would, without dwa knowing. */
  function personal(name: string, text: string): void {
    mkdirSync(home("roles"), { recursive: true });
    writeFileSync(home("roles", `${name}.toml`), text);
  }
  function personalConfig(text: string): void {
    mkdirSync(home(), { recursive: true });
    writeFileSync(home("config.toml"), text);
  }
  const sources = (ref: Parameters<typeof roleHistory>[0]) =>
    readHistory(roleHistory(ref, ctx)).versions.map((version) => version.source);
  const places = () => listAllRoles(ctx).map((role) => [role.name, role.source, role.hidden]);

  test("a hidden personal role is saved by its place and the project's role stays as it is", () => {
    personal("explore", 'description = "Mine"\n');
    const project = roleText("explore");
    const version = saveValues(
      { kind: "role", name: "explore", source: "user" },
      { model: "haiku" },
      "role settings",
      ctx,
    );
    expect(personalText("explore")).toBe('description = "Mine"\nmodel = "haiku"\n');
    expect(roleText("explore")).toBe(project);
    expect(version.n).toBe(2);
    expect(sources({ name: "explore", source: "user" })).toEqual([
      "first version",
      "role settings",
    ]);
    expect(existsSync(home("history", "roles", "explore", "v2.toml"))).toBe(true);
    // The project's role has its own history, which this save did not touch.
    expect(existsSync(join(dir, ".dwa", "history", "roles", "explore", "v2.toml"))).toBe(false);
    // A bare name still means the project's file.
    expect(findRole("explore", ctx)?.source).toBe("project");
    expect(findRoleIn({ name: "explore", source: "user" }, ctx)?.role.model).toBe("haiku");
  });

  test("a hidden personal role is renamed alone: what names the role is left to the project's", () => {
    personal("explore", 'description = "Mine"\n');
    writeFileSync(join(dir, ".dwa", "config.toml"), '[[agents]]\nname = "r"\nrole = "explore"\n');
    personalConfig('[main]\nrole = "explore"\n');
    noticeEdits(ctx);
    const before = {
      project: roleText("explore"),
      reviewer: roleText("reviewer"),
      config: configText(),
      workflow: workflowText(),
    };
    const renamed = renameRole({ name: "explore", source: "user" }, "scout", ctx);
    expect(renamed).toEqual({ name: "scout", source: "user", path: home("roles", "scout.toml") });
    expect(existsSync(home("roles", "explore.toml"))).toBe(false);
    expect(personalText("scout")).toBe('description = "Mine"\n');
    expect({
      project: roleText("explore"),
      reviewer: roleText("reviewer"),
      config: configText(),
      workflow: workflowText(),
    }).toEqual(before);
    expect(readFileSync(home("config.toml"), "utf8")).toBe('[main]\nrole = "explore"\n');
    // Its history went with it, inside the personal folder.
    expect(existsSync(home("history", "roles", "explore"))).toBe(false);
    expect(sources({ name: "scout", source: "user" })).toEqual(["first version"]);
    expect(places()).toContainEqual(["scout", "user", false]);
    // A name taken in either place is refused.
    expect(() => renameRole({ name: "scout", source: "user" }, "reviewer", ctx)).toThrow(
      'There is already a role "reviewer".',
    );
  });

  test("a hidden personal role is deleted although the name is in use", () => {
    personal("explore", 'description = "Mine"\n');
    expect(roleUsers("explore", ctx).length).toBeGreaterThan(0);
    expect(roleUsers({ name: "explore", source: "user" }, ctx)).toEqual([]);
    const project = roleText("explore");
    deleteRole({ name: "explore", source: "user" }, ctx);
    expect(existsSync(home("roles", "explore.toml"))).toBe(false);
    expect(roleText("explore")).toBe(project);
    expect(existsSync(home("history", "roles", "explore", "v1.toml"))).toBe(true);
    expect(() => deleteRole("explore", ctx)).toThrow("still used");
    expect(() => deleteRole({ name: "explore", source: "user" }, ctx)).toThrow(
      'Unknown personal role "explore".',
    );
  });

  test("duplicates into the other place, or next to the original when none is named", () => {
    const copy = duplicateRole("reviewer", "critic", ctx, { personal: true });
    expect(copy).toEqual({ name: "critic", source: "user", path: home("roles", "critic.toml") });
    expect(personalText("critic")).toBe(roleText("reviewer"));
    expect(sources({ name: "critic", source: "user" })).toEqual(["copy of reviewer"]);
    expect(existsSync(join(dir, ".dwa", "roles", "critic.toml"))).toBe(false);

    const back = duplicateRole({ name: "critic", source: "user" }, "judge", ctx, {
      personal: false,
    });
    expect(back.source).toBe("project");
    expect(roleText("judge")).toBe(personalText("critic"));
    expect(existsSync(join(dir, ".dwa", "history", "roles", "judge", "v1.toml"))).toBe(true);

    // A copy of a personal role is personal unless told otherwise.
    expect(duplicateRole("critic", "critic2", ctx).source).toBe("user");
    expect(duplicateRole("judge", "judge2", ctx).source).toBe("project");
    expect(() => duplicateRole("reviewer", "critic", ctx)).toThrow(
      'There is already a personal role "critic".',
    );
    expect(() => duplicateRole("reviewer", "judge", ctx, { personal: true })).toThrow(
      'There is already a role "judge".',
    );
  });

  test("moves a role to the other place with its history; the name still finds it", () => {
    saveValues({ kind: "role", name: "developer" }, { effort: "low" }, "role settings", ctx);
    const text = roleText("developer");
    const moved = moveRole("developer", "user", ctx);
    expect(moved).toEqual({
      name: "developer",
      source: "user",
      path: home("roles", "developer.toml"),
    });
    expect(existsSync(join(dir, ".dwa", "roles", "developer.toml"))).toBe(false);
    expect(personalText("developer")).toBe(text);
    expect(findRole("developer", ctx)?.source).toBe("user");
    expect(sources("developer")).toEqual(["first version", "role settings"]);
    expect(existsSync(home("history", "roles", "developer", "v2.toml"))).toBe(true);
    expect(existsSync(join(dir, ".dwa", "history", "roles", "developer"))).toBe(false);
    // The workflow that names it was not changed and still resolves.
    expect(Object.values(loadWorkflow(dir, "feature").steps).map((step) => step.role)).toContain(
      "developer",
    );

    expect(() => moveRole("developer", "user", ctx)).toThrow("already personal");
    expect(moveRole({ name: "developer", source: "user" }, "project", ctx).source).toBe("project");
    expect(roleText("developer")).toBe(text);
    expect(sources("developer")).toEqual(["first version", "role settings"]);

    personal("explore", "");
    expect(() => moveRole("explore", "user", ctx)).toThrow(
      'There is already a personal role "explore"',
    );
    expect(() => moveRole({ name: "explore", source: "user" }, "project", ctx)).toThrow(
      'There is already a project role "explore"',
    );
  });

  test("notices hand edits of a personal role, of a hidden one and of the personal config", () => {
    personal("mine", 'description = "Mine"\n');
    personal("explore", 'description = "Hidden"\n');
    personalConfig('[defaults]\nmodel = "opus"\n');
    noticeEdits(ctx);
    const config = trackedConfig(dir, "user", ctx.env);
    expect(config.dir).toBe(home("history", "config"));
    expect(readHistory(config).versions.map((version) => version.source)).toEqual([
      "first version",
    ]);

    personal("mine", 'description = "Mine, edited"\n');
    personal("explore", 'description = "Hidden, edited"\n');
    personalConfig('[defaults]\nmodel = "haiku"\n');
    noticeEdits(ctx);
    noticeEdits(ctx);
    for (const name of ["mine", "explore"]) {
      expect(sources({ name, source: "user" })).toEqual(["first version", "edited by hand"]);
      expect(versionText(roleHistory({ name, source: "user" }, ctx), 2)).toContain("edited");
    }
    expect(readHistory(config).versions.map((version) => version.source)).toEqual([
      "first version",
      "edited by hand",
    ]);
    expect(versionText(config, 1)).toBe('[defaults]\nmodel = "opus"\n');
    // The project's explore was not edited and has one version.
    expect(sources({ name: "explore", source: "project" })).toEqual(["first version"]);
    expect(readHistory(trackedConfig(dir)).versions).toHaveLength(1);
  });

  test("renaming a role that is used follows a mention in the personal config, with a version", () => {
    personalConfig('# mine\n[main]\nrole = "explore" # reads\n\n[defaults]\nmodel = "opus"\n');
    noticeEdits(ctx);
    renameRole("explore", "scout", ctx);
    expect(readFileSync(home("config.toml"), "utf8")).toBe(
      '# mine\n[main]\nrole = "scout" # reads\n\n[defaults]\nmodel = "opus"\n',
    );
    const config = trackedConfig(dir, "user", ctx.env);
    expect(readHistory(config).versions.map((version) => [version.n, version.source])).toEqual([
      [1, "first version"],
      [2, "role explore renamed to scout"],
    ]);
    expect(versionText(config, 1)).toContain('role = "explore"');
    expect(findRole("reviewer", ctx)?.role.extends).toBe("scout");
  });

  test("a personal role that is used is renamed everywhere too, and a personal child follows", () => {
    personal("base", 'description = "Base"\n');
    personal("child", 'extends = "base"\n');
    saveValues({ kind: "role", name: "reviewer" }, { extends: "base" }, "role settings", ctx);
    const renamed = renameRole("base", "root", ctx);
    expect(renamed.source).toBe("user");
    expect(findRole("reviewer", ctx)?.role.extends).toBe("root");
    expect(findRoleIn({ name: "child", source: "user" }, ctx)?.role.extends).toBe("root");
    expect(sources({ name: "child", source: "user" }).at(-1)).toBe("role base renamed to root");
  });

  test("roleUsers reports the personal config next to the project's", () => {
    personalConfig('[main]\nrole = "explore"\n\n[[agents]]\nname = "r"\nrole = "explore"\n');
    expect(roleUsers("explore", ctx)).toEqual([
      "role reviewer extends it",
      "the main session ([main] in your personal config.toml)",
      "[[agents]] in your personal config.toml",
      "workflow bugfix, step diagnose",
      "workflow feature, step explore",
      "workflow parallel-build, step explore",
    ]);
    expect(() => deleteRole("explore", ctx)).toThrow("your personal config.toml");
    // A personal role that is the one used has users like any other.
    personal("mine", "");
    personalConfig('[[agents]]\nname = "m"\nrole = "mine"\n');
    expect(roleUsers({ name: "mine", source: "user" }, ctx)).toEqual([
      "[[agents]] in your personal config.toml",
    ]);
  });

  test("roleUsers names a personal workflow as such, and not one the project hides", () => {
    const workflow = (name: string, text: string) => {
      mkdirSync(home("workflows"), { recursive: true });
      writeFileSync(home("workflows", `${name}.toml`), text);
    };
    workflow("mine", '[steps.look]\nrole = "explore"\nprompt = "x"\n');
    workflow("feature", '[steps.hidden]\nrole = "explore"\nprompt = "x"\n');
    expect(roleUsers("explore", ctx)).toEqual([
      "role reviewer extends it",
      "workflow bugfix, step diagnose",
      "workflow feature, step explore",
      "your personal workflow mine, step look",
      "workflow parallel-build, step explore",
    ]);
    expect(() => deleteRole("explore", ctx)).toThrow("your personal workflow mine, step look");
    // A personal role used by a personal workflow only.
    personal("own", "");
    workflow("solo", '[steps.one]\nrole = "own"\nprompt = "x"\n');
    expect(roleUsers("own", ctx)).toEqual(["your personal workflow solo, step one"]);
  });

  test("a rename follows a personal workflow, in the personal history, and not a hidden one", () => {
    const hidden = '[steps.hidden]\nrole = "explore"\nprompt = "x"\n';
    mkdirSync(home("workflows"), { recursive: true });
    writeFileSync(home("workflows", "mine.toml"), '[steps.look]\nrole = "explore"\nprompt = "x"\n');
    writeFileSync(home("workflows", "feature.toml"), hidden);
    renameRole("explore", "scout", ctx);
    expect(readFileSync(home("workflows", "mine.toml"), "utf8")).toBe(
      '[steps.look]\nrole = "scout"\nprompt = "x"\n',
    );
    expect(readFileSync(home("history", "workflows", "mine", "v2.toml"), "utf8")).toContain(
      'role = "scout"',
    );
    expect(existsSync(join(dir, ".dwa", "history", "workflows", "mine"))).toBe(false);
    expect(workflowText()).toContain('role = "scout"');
    expect(existsSync(join(dir, ".dwa", "history", "workflows", "feature", "v2.toml"))).toBe(true);
    // The personal workflow of the project's name is not used here and stays as it is.
    expect(readFileSync(home("workflows", "feature.toml"), "utf8")).toBe(hidden);
    expect(existsSync(home("history", "workflows", "feature", "v2.toml"))).toBe(false);
  });

  test("warns about other projects when a personal role is renamed, deleted or moved", () => {
    personal("mine", "");
    const about = (what: string) => [
      `Other projects that use your personal role "mine" are not checked: they ${what}.`,
    ];
    expect(scopeWarnings("rename", "mine", ctx)).toEqual(about("still name it by the old name"));
    expect(scopeWarnings("delete", "mine", ctx)).toEqual(about("will no longer find it"));
    expect(scopeWarnings("move", { name: "mine", source: "user" }, ctx)).toEqual(
      about("will no longer find it among your personal roles"),
    );
    expect(scopeWarnings("save", "mine", ctx)).toEqual([]);
    // The same for one the project hides.
    personal("explore", "");
    expect(scopeWarnings("delete", { name: "explore", source: "user" }, ctx)).toEqual([
      'Other projects that use your personal role "explore" are not checked: they will no longer find it.',
    ]);
  });

  test("warns that a hidden personal role comes forward when the project's goes", () => {
    expect(scopeWarnings("delete", "developer", ctx)).toEqual([]);
    expect(scopeWarnings("rename", "developer", ctx)).toEqual([]);
    personal("developer", "");
    const twin = [
      'Your personal role "developer" is hidden by this one and will be the one used here afterwards.',
    ];
    expect(scopeWarnings("delete", "developer", ctx)).toEqual(twin);
    expect(scopeWarnings("rename", { name: "developer", source: "project" }, ctx)).toEqual(twin);
  });

  test("warns when a project role depends on a personal one: on save and on a move", () => {
    expect(scopeWarnings("save", "reviewer", ctx)).toEqual([]);
    personal("base", "");
    saveValues({ kind: "role", name: "reviewer" }, { extends: "base" }, "role settings", ctx);
    expect(scopeWarnings("save", "reviewer", ctx)).toEqual([
      'Role "reviewer" is in the project but starts from your personal role "base", ' +
        "which others who use this project do not have.",
    ]);
    // A personal role may start from a personal one.
    personal("child", 'extends = "base"\n');
    expect(scopeWarnings("save", "child", ctx)).toEqual([]);

    saveValues({ kind: "role", name: "reviewer" }, { extends: "explore" }, "role settings", ctx);
    expect(scopeWarnings("save", "reviewer", ctx)).toEqual([]);
    expect(scopeWarnings("move", "explore", ctx)).toEqual([
      'Others who use this project will no longer have role "explore".',
      'Role "reviewer" is in the project but starts from your personal role "explore", ' +
        "which others who use this project do not have.",
    ]);
    expect(scopeWarnings("move", "developer", ctx)).toEqual([
      'Others who use this project will no longer have role "developer".',
    ]);
    expect(() => scopeWarnings("move", "nobody", ctx)).toThrow('Unknown role "nobody".');
  });

  test("the personal [defaults] are written in the personal config and versioned at home", () => {
    const project = configText();
    const target = { kind: "defaults", source: "user" } as const;
    expect(originTarget(PERSONAL_DEFAULTS)).toEqual(target);
    expect(describeTarget(target)).toBe("[defaults] in your personal config.toml");
    // There is no personal config yet: the save makes one.
    const first = saveValues(target, { model: "haiku" }, "tools dialog", ctx);
    expect(readFileSync(home("config.toml"), "utf8")).toContain('[defaults]\nmodel = "haiku"\n');
    expect(first.n).toBe(1);

    personalConfig('# mine\n[profiles.me]\ncommand = "claude"\n\n[defaults]\nmodel = "haiku"\n');
    const next = saveValues(target, { deny_tools: ["WebFetch"], model: null }, "tools dialog", ctx);
    expect(readFileSync(home("config.toml"), "utf8")).toBe(
      '# mine\n[profiles.me]\ncommand = "claude"\n\n[defaults]\ndeny_tools = ["WebFetch"]\n',
    );
    const config = trackedConfig(dir, "user", ctx.env);
    expect(readHistory(config).versions.map((version) => [version.n, version.source])).toEqual([
      [1, "tools dialog"],
      [2, "edited by hand"],
      [3, "tools dialog"],
    ]);
    expect(next.n).toBe(3);
    expect(existsSync(home("history", "config", "v3.toml"))).toBe(true);
    // The project's config and its history are not part of it.
    expect(configText()).toBe(project);
    expect(existsSync(join(dir, ".dwa", "history", "config"))).toBe(false);
    expect(() => saveValues(target, { prompt: "x" }, "x", ctx)).toThrow("cannot hold");
    expect(() => saveValues(target, { effort: "huge" as never }, "x", ctx)).toThrow();
  });
});
