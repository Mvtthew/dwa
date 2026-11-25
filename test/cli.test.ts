import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_TEMPLATE, initProject } from "../src/cli/init.ts";
import { projectRoles } from "../src/cli/palette.ts";
import { parseConfig } from "../src/shared/config.ts";
import { checkSessions, resolveSession } from "../src/shared/roles.ts";
import { listWorkflows, loadWorkflow } from "../src/shared/workflow.ts";

/** Keeps the roles of whoever runs the tests (~/.config/dwa/roles) out of them. */
const ENV = { XDG_CONFIG_HOME: "/nonexistent" };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dwa-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("init", () => {
  test("the config template is valid and sets only the models", () => {
    expect(parseConfig(CONFIG_TEMPLATE, "template")).toEqual({
      profiles: {},
      keys: {},
      agents: [],
      layout: {},
      defaults: { model: "sonnet", effort: "medium" },
      main: { model: "opus", effort: "medium" },
      mcp: {},
      plugins: {},
    });
  });

  test("creates the config, and roles and the ignore entry when asked and applicable", () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/");
    const result = initProject(dir, { roles: true });
    expect(existsSync(join(dir, ".dwa", "config.toml"))).toBe(true);
    expect(projectRoles(dir, ENV)).toEqual(["developer", "explore", "main", "reviewer"]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n.dwa/run/\n");
    expect(result.created).toHaveLength(8);
    expect(listWorkflows(dir).map((workflow) => [workflow.name, workflow.error])).toEqual([
      ["feature", null],
    ]);
    expect(readFileSync(join(dir, ".dwa", "roles", "reviewer.toml"), "utf8")).toContain(
      'extends = "explore"',
    );
  });

  test("the example roles resolve with the template config, and the workflow uses only them", () => {
    initProject(dir, { roles: true });
    const config = parseConfig(CONFIG_TEMPLATE, "template");
    const ctx = { projectRoot: dir, env: ENV };
    const session = (role: string) => resolveSession({ config, role }, ctx);
    for (const role of projectRoles(dir, ENV)) expect(session(role).prompt).toBeTruthy();
    expect(session("developer")).toMatchObject({
      model: "sonnet",
      effort: "high",
      permissionMode: "acceptEdits",
      deny: ["Bash(git push *)"],
      memory: false,
    });
    expect(session("explore")).toMatchObject({
      tools: ["Read", "Grep", "Glob", "Bash"],
      permissionMode: "dontAsk",
    });
    // The reviewer takes tools, mode and rules from explore and adds its own model and skill.
    const reviewer = session("reviewer");
    expect(reviewer).toMatchObject({
      model: "opus",
      tools: ["Read", "Grep", "Glob", "Bash"],
      permissionMode: "dontAsk",
      allow: session("explore").allow,
    });
    expect(reviewer.skills?.map((skill) => [skill.name, skill.source])).toEqual([
      ["review-checklist", "dwa"],
    ]);
    // [main] in the template wins over the role's effort.
    expect(resolveSession({ config, main: true }, ctx)).toMatchObject({
      role: "main",
      model: "opus",
      effort: "medium",
      memory: true,
    });
    expect(checkSessions(config, ctx)).toEqual([]);
    const steps = Object.values(loadWorkflow(dir, "feature").steps);
    expect(steps.every((step) => step.role && projectRoles(dir, ENV).includes(step.role))).toBe(
      true,
    );
  });

  test("never overwrites existing files and leaves non-git folders without .gitignore", () => {
    mkdirSync(join(dir, ".dwa"));
    writeFileSync(join(dir, ".dwa", "config.toml"), "# mine");
    const result = initProject(dir, { roles: false });
    expect(readFileSync(join(dir, ".dwa", "config.toml"), "utf8")).toBe("# mine");
    expect(result.created).toEqual([]);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });

  test("running it twice adds the ignore entry once", () => {
    mkdirSync(join(dir, ".git"));
    initProject(dir, { roles: false });
    initProject(dir, { roles: false });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".dwa/run/\n");
  });
});
