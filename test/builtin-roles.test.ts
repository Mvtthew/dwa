import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_CONFIG } from "../src/shared/config.ts";
import { readHistory } from "../src/shared/history.ts";
import { builtinRolesDir, builtinSkillsDir } from "../src/shared/paths.ts";
import {
  adoptRole,
  createRole,
  deleteRole,
  duplicateRole,
  renameRole,
  requireRole,
  roleHistory,
  saveValues,
} from "../src/shared/role-edit.ts";
import { guideEntries, roleGuidePrompt } from "../src/shared/role-guide.ts";
import {
  checkSessions,
  findRole,
  findRoleIn,
  findSkill,
  listAllRoles,
  listBuiltinRoles,
  listRoles,
  type RoleContext,
  resolveSession,
} from "../src/shared/roles.ts";
import { rolesScreen } from "../src/ui/role-screens.ts";
import { diskRoleStore } from "../src/ui/role-store.ts";

const EXPLORE = `description = "Reads the code"
when_to_use = "Questions about the code."
tools = ["Read", "Grep"]
prompt = "You read."
`;
const REVIEWER = `description = "Reviews"
extends = "explore"
skills = ["checklist"]
`;

let dir: string;
let builtin: string;
let ctx: RoleContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dwa-builtin-"));
  builtin = join(dir, "carried");
  mkdirSync(join(builtin, "roles"), { recursive: true });
  mkdirSync(join(builtin, "skills", "checklist"), { recursive: true });
  writeFileSync(join(builtin, "roles", "explore.toml"), EXPLORE);
  writeFileSync(join(builtin, "roles", "reviewer.toml"), REVIEWER);
  writeFileSync(join(builtin, "skills", "checklist", "SKILL.md"), "---\nname: checklist\n---\n");
  const projectRoot = join(dir, "project");
  mkdirSync(projectRoot);
  ctx = { projectRoot, env: { XDG_CONFIG_HOME: join(dir, "home"), DWA_BUILTIN_DIR: builtin } };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const projectRole = (name: string) => join(ctx.projectRoot, ".dwa", "roles", `${name}.toml`);

describe("where the built-in roles are", () => {
  test("the folder dwa carries, another one, or none", () => {
    expect(builtinRolesDir({})).toEndWith("/examples/roles");
    expect(builtinSkillsDir({})).toEndWith("/examples/skills");
    expect(builtinRolesDir({ DWA_BUILTIN_DIR: "/x" })).toBe("/x/roles");
    expect(builtinRolesDir({ DWA_BUILTIN_DIR: "" })).toBeNull();
    expect(builtinSkillsDir({ DWA_BUILTIN_DIR: "" })).toBeNull();
  });

  test("every role dwa carries resolves in a project with no files of its own", () => {
    const bare: RoleContext = { ...ctx, env: { XDG_CONFIG_HOME: join(dir, "home") } };
    const names = listRoles(bare).map((role) => role.name);
    expect(names).toEqual(expect.arrayContaining(["developer", "explore", "main", "reviewer"]));
    expect(checkSessions(EMPTY_CONFIG, bare)).toEqual([]);
  });
});

describe("a project without role files", () => {
  test("has the built-in roles", () => {
    expect(listRoles(ctx).map(({ name, source }) => [name, source])).toEqual([
      ["explore", "builtin"],
      ["reviewer", "builtin"],
    ]);
    expect(findRole("explore", ctx)?.source).toBe("builtin");
    expect(findRoleIn({ name: "explore", source: "builtin" }, ctx)?.role.prompt).toBe("You read.");
    // The editors list files only.
    expect(listAllRoles(ctx)).toEqual([]);
  });

  test("a session runs as one, with the skill dwa carries for it", () => {
    const session = resolveSession({ config: EMPTY_CONFIG, role: "reviewer" }, ctx);
    expect(session.tools).toEqual(["Read", "Grep"]);
    expect(session.prompt).toBe("You read.");
    expect(findSkill("checklist", ctx)).toMatchObject({ source: "builtin" });
    expect(session.skills?.map((skill) => skill.name)).toEqual(["checklist"]);
  });

  test("they are in the list of roles to hand work to", () => {
    expect(roleGuidePrompt(guideEntries(ctx))).toContain("- explore: Questions about the code.");
  });

  test("without a folder of built-in roles there are none", () => {
    const none = { ...ctx, env: { ...ctx.env, DWA_BUILTIN_DIR: "" } };
    expect(listRoles(none)).toEqual([]);
    expect(listBuiltinRoles(none)).toEqual([]);
    expect(findRole("explore", none)).toBeNull();
    expect(findRoleIn({ name: "explore", source: "builtin" }, none)).toBeNull();
  });
});

describe("a file of the same name", () => {
  test("takes the built-in role's place, also as the parent of a built-in role", () => {
    createRole("explore", 'tools = ["Read"]\nprompt = "Mine."\n', "test", ctx);
    expect(findRole("explore", ctx)?.source).toBe("project");
    expect(listRoles(ctx).map(({ name, source }) => [name, source])).toEqual([
      ["explore", "project"],
      ["reviewer", "builtin"],
    ]);
    const session = resolveSession({ config: EMPTY_CONFIG, role: "reviewer" }, ctx);
    expect(session.prompt).toBe("Mine.");
    expect(session.tools).toEqual(["Read"]);
  });

  test("a personal file does too", () => {
    createRole("explore", 'prompt = "Personal."\n', "test", ctx, { personal: true });
    expect(findRole("explore", ctx)?.source).toBe("user");
  });

  test("a project role may start from a built-in one", () => {
    createRole("auditor", 'extends = "explore"\n', "test", ctx);
    expect(resolveSession({ config: EMPTY_CONFIG, role: "auditor" }, ctx).prompt).toBe("You read.");
  });
});

describe("the role settings", () => {
  test("list the built-in roles apart from the files, until one is copied", () => {
    const store = diskRoleStore(ctx.projectRoot, null, ctx.env);
    expect(store.list()).toEqual([]);
    expect(store.builtins()).toEqual([
      { name: "explore", description: "Reads the code", whenToUse: "Questions about the code." },
      { name: "reviewer", description: "Reviews", whenToUse: null },
    ]);
    const screen = rolesScreen({ call: async () => ({}) } as never, store);
    const hints = screen.rows.flatMap((row) => (row.kind === "button" ? [row.hint] : []));
    expect(hints).toContain("built in · Reads the code");

    store.adopt("explore", "project");
    expect(store.list().map((role) => role.name)).toEqual(["explore"]);
    expect(store.builtins().map((role) => role.name)).toEqual(["reviewer"]);
  });
});

describe("changing a built-in role", () => {
  test("is refused until it is copied", () => {
    expect(() => requireRole("explore", ctx)).toThrow(/built into dwa.*role adopt explore/);
    expect(() =>
      saveValues({ kind: "role", name: "explore" }, { model: "opus" }, "t", ctx),
    ).toThrow(/built into dwa/);
    expect(() => deleteRole("explore", ctx)).toThrow(/built into dwa/);
    expect(() => renameRole("explore", "reader", ctx)).toThrow(/built into dwa/);
    expect(() => requireRole("nothing", ctx)).toThrow('Unknown role "nothing".');
  });

  test("adopting makes a file with the same text and a first version", () => {
    const entry = adoptRole("explore", ctx);
    expect(entry).toEqual({ name: "explore", source: "project", path: projectRole("explore") });
    expect(readFileSync(entry.path, "utf8")).toBe(EXPLORE);
    const history = readHistory(roleHistory("explore", ctx));
    expect(history.versions.map((version) => version.source)).toEqual([
      "copy of the built-in role",
    ]);
    saveValues({ kind: "role", name: "explore" }, { model: "opus" }, "t", ctx);
    expect(findRole("explore", ctx)?.role.model).toBe("opus");
    // The built-in text is untouched.
    expect(readFileSync(join(builtin, "roles", "explore.toml"), "utf8")).toBe(EXPLORE);
  });

  test("adopting into the personal folder, and not twice", () => {
    const entry = adoptRole("explore", ctx, { personal: true });
    expect(entry.source).toBe("user");
    expect(() => adoptRole("explore", ctx)).toThrow('There is already a personal role "explore".');
    expect(() => adoptRole("nothing", ctx)).toThrow('There is no built-in role "nothing".');
  });

  test("a copy under another name starts from the built-in text", () => {
    const copy = duplicateRole("explore", "reader", ctx);
    expect(copy.source).toBe("project");
    expect(readFileSync(copy.path, "utf8")).toBe(EXPLORE);
  });

  test("deleting the file brings the built-in role back, even while it is used", () => {
    adoptRole("explore", ctx);
    createRole("auditor", 'extends = "explore"\n', "test", ctx);
    deleteRole("explore", ctx);
    expect(existsSync(projectRole("explore"))).toBe(false);
    expect(findRole("explore", ctx)?.source).toBe("builtin");
    expect(resolveSession({ config: EMPTY_CONFIG, role: "auditor" }, ctx).prompt).toBe("You read.");
  });

  test("renaming a role leaves the built-in roles that name it alone", () => {
    adoptRole("explore", ctx);
    renameRole("explore", "reader", ctx);
    // "reviewer" is built in and extends "explore", which is the built-in one again.
    expect(readFileSync(join(builtin, "roles", "reviewer.toml"), "utf8")).toBe(REVIEWER);
    expect(findRole("explore", ctx)?.source).toBe("builtin");
    expect(findRole("reader", ctx)?.source).toBe("project");
  });
});
