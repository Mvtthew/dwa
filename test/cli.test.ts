import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_TEMPLATE, initProject } from "../src/cli/init.ts";
import { filterItems, paletteItems, projectRoles } from "../src/cli/palette.ts";
import { parseConfig } from "../src/shared/config.ts";
import type { AgentInfo, WorkspaceState } from "../src/shared/protocol.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dwa-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("init", () => {
  test("the config template is valid and changes nothing until edited", () => {
    expect(parseConfig(CONFIG_TEMPLATE, "template")).toEqual({
      profiles: {},
      keys: {},
      agents: [],
      layout: {},
    });
  });

  test("creates the config, and roles and the ignore entry when asked and applicable", () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/");
    const result = initProject(dir, { roles: true });
    expect(existsSync(join(dir, ".dwa", "config.toml"))).toBe(true);
    expect(projectRoles(dir)).toEqual(["developer", "explore", "reviewer"]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n.dwa/run/\n");
    expect(result.created).toHaveLength(5);
    expect(readFileSync(join(dir, ".claude", "agents", "reviewer.md"), "utf8")).toContain(
      "name: reviewer",
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

describe("palette", () => {
  const agent = (name: string, open = false) => ({ id: `id-${name}`, name, open }) as AgentInfo;
  const state = (agents: AgentInfo[], questions = 0): WorkspaceState => ({
    projectRoot: "/p",
    keyPrefix: "C-q",
    up: true,
    main: agent("main"),
    agents,
    questions: Array.from({ length: questions }, () => ({})) as WorkspaceState["questions"],
    inbox: [],
  });

  test("offers what is possible in the current state", () => {
    const labels = paletteItems(state([agent("dev", true), agent("rev")], 2), ["reviewer"]).map(
      (item) => item.label,
    );
    expect(labels).toEqual([
      "Answer questions (2 open)",
      "Open rev",
      "Close dev",
      "Focus main",
      "Message main",
      "Message dev",
      "Message rev",
      "Start agent",
      "Start agent as reviewer",
      "Stop dev",
      "Stop rev",
      "Stop the workspace",
    ]);
  });

  test("an empty workspace offers only the general actions", () => {
    expect(paletteItems(state([]), []).map((item) => item.label)).toEqual([
      "Focus main",
      "Message main",
      "Start agent",
      "Stop the workspace",
    ]);
  });

  test("filtering matches every word, in any order and case", () => {
    const items = paletteItems(state([agent("dev"), agent("rev")]), ["reviewer"]);
    expect(filterItems(items, "REV stop").map((item) => item.label)).toEqual(["Stop rev"]);
    expect(filterItems(items, "start").map((item) => item.label)).toEqual([
      "Start agent",
      "Start agent as reviewer",
    ]);
    expect(filterItems(items, "zzz")).toEqual([]);
  });
});
