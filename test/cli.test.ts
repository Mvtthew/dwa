import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_TEMPLATE, initProject } from "../src/cli/init.ts";
import { projectRoles } from "../src/cli/palette.ts";
import { parseConfig } from "../src/shared/config.ts";
import { listWorkflows } from "../src/shared/workflow.ts";

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
    });
  });

  test("creates the config, and roles and the ignore entry when asked and applicable", () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/");
    const result = initProject(dir, { roles: true });
    expect(existsSync(join(dir, ".dwa", "config.toml"))).toBe(true);
    expect(projectRoles(dir)).toEqual(["developer", "explore", "reviewer"]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n.dwa/run/\n");
    expect(result.created).toHaveLength(6);
    expect(listWorkflows(dir).map((workflow) => [workflow.name, workflow.error])).toEqual([
      ["feature", null],
    ]);
    expect(readFileSync(join(dir, ".claude", "agents", "reviewer.md"), "utf8")).toContain(
      "name: reviewer",
    );
  });

  test("example roles do not list allowed tools, which would hide the dwa tools", () => {
    initProject(dir, { roles: true });
    for (const role of projectRoles(dir)) {
      const text = readFileSync(join(dir, ".claude", "agents", `${role}.md`), "utf8");
      expect(text).not.toMatch(/^tools:/m);
    }
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
