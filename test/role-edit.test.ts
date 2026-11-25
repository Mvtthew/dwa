import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../src/cli/init.ts";
import { loadConfig } from "../src/shared/config.ts";
import { readHistory, versionText } from "../src/shared/history.ts";
import {
  createRole,
  deleteRole,
  duplicateRole,
  noticeEdits,
  originTarget,
  renameRole,
  roleHistory,
  roleTemplate,
  roleUsers,
  saveValues,
} from "../src/shared/role-edit.ts";
import { findRole, type RoleContext, resolveSession } from "../src/shared/roles.ts";
import { loadWorkflow } from "../src/shared/workflow.ts";

let dir: string;
let ctx: RoleContext;
const roleText = (name: string) => readFileSync(join(dir, ".dwa", "roles", `${name}.toml`), "utf8");
const configText = () => readFileSync(join(dir, ".dwa", "config.toml"), "utf8");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dwa-role-edit-"));
  // A personal folder of its own, so the roles of whoever runs the tests stay out.
  ctx = { projectRoot: dir, env: { XDG_CONFIG_HOME: join(dir, "home") } };
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

  test("lists what uses a role and refuses to delete it meanwhile", () => {
    writeFileSync(
      join(dir, ".dwa", "config.toml"),
      '[main]\nrole = "main"\n\n[[agents]]\nname = "r"\nrole = "explore"\n',
    );
    expect(roleUsers("explore", ctx)).toEqual([
      "role reviewer extends it",
      "[[agents]] in config.toml",
      "workflow feature, step explore",
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
