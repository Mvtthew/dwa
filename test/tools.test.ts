import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/shared/config.ts";
import { type ResolvedSession, resolveLayers, resolveSession } from "../src/shared/roles.ts";
import {
  applyToolChanges,
  isBlocked,
  liveBlocks,
  type ToolSources,
  toolView,
} from "../src/shared/tools.ts";
import { testRoleFiles } from "./role-files.ts";

const sources: ToolSources = {
  projectServers: ["notes"],
  catalogue: ["github", "docs"],
  serverTools: { github: ["create_issue", "list_issues"], notes: null },
  seen: ["Read", "TodoWrite", "mcp__notes__search"],
};

describe("toolView", () => {
  test("shows an allow list as the only tools that are on", () => {
    const view = toolView(
      { tools: ["Read", "Bash"], mcp: ["github"] },
      { tools: "role explore" },
      sources,
    );
    expect(view.mode).toBe("only");
    expect(view.tools.filter((tool) => tool.on).map((tool) => tool.name)).toEqual(["Bash", "Read"]);
    // A tool the session used is listed although dwa's own list does not have it.
    expect(view.tools.map((tool) => tool.name)).toContain("TodoWrite");
    expect(view.origins.tools).toBe("role explore");
  });

  test("without a list of its own a session has the default tools, less what is taken away", () => {
    const on = (caps: Parameters<typeof toolView>[0]) =>
      toolView(caps, {}, { ...sources, seen: [] })
        .tools.filter((tool) => tool.on)
        .map((tool) => tool.name);
    expect(toolView({}, {}, sources).mode).toBe("only");
    expect(on({})).toEqual([
      "AskUserQuestion",
      "Bash",
      "Edit",
      "Read",
      "Skill",
      "Write",
      "Glob",
      "Grep",
      "ExitPlanMode",
    ]);
    expect(on({ deny_tools: ["Edit", "Write"] })).not.toContain("Edit");
    expect(on({ subagents: true })).toContain("Agent");
    expect(on({ tools: ["*"] })).toContain("WebSearch");
    expect(toolView({ tools: ["*"] }, {}, sources).tools.map((tool) => tool.name)).not.toContain(
      "*",
    );
  });

  test("shows denied tools, servers of every kind and the rules", () => {
    const view = toolView(
      {
        // Every tool the command ships, less what is taken away.
        tools: ["*"],
        deny_tools: ["Edit"],
        deny: ["Bash", "Bash(git push *)", "mcp__github__create_issue", "mcp__docs"],
        allow: ["Bash(git log *)"],
        mcp: ["github", "docs"],
        off_mcp: ["notes"],
      },
      {},
      sources,
    );
    expect(view.mode).toBe("except");
    // Agent and Workflow are off as well: the session has no `subagents`.
    expect(view.tools.filter((tool) => !tool.on).map((tool) => tool.name)).toEqual([
      "Agent",
      "Bash",
      "Edit",
      "Workflow",
    ]);
    expect(view.servers.map((s) => [s.name, s.from, s.on])).toEqual([
      ["dwa", "dwa", true],
      ["notes", "project", false],
      ["github", "catalogue", true],
      ["docs", "catalogue", false],
    ]);
    expect(view.servers[0]?.fixed).toBe("always on");
    expect(view.servers[2]?.tools).toEqual([
      { name: "create_issue", on: false },
      { name: "list_issues", on: true },
    ]);
    // Not asked, but one tool was seen in use.
    expect(view.servers[1]?.tools).toEqual([{ name: "search", on: true }]);
    expect(view.servers[3]?.tools).toBeNull();
    expect(view.rules).toEqual([
      { list: "allow", rule: "Bash(git log *)" },
      { list: "deny", rule: "Bash(git push *)" },
    ]);
  });

  test("shows the tools that start subagents as off unless subagents is set", () => {
    const row = (caps: Parameters<typeof toolView>[0], name: string) =>
      toolView(caps, {}, { ...sources, seen: ["Workflow"] }).tools.find(
        (tool) => tool.name === name,
      );
    for (const name of ["Agent", "Workflow"]) {
      expect(row({}, name)).toEqual({ name, on: false });
      expect(row({ subagents: false }, name)).toEqual({ name, on: false });
      // An allow list that names them does not bring them back.
      expect(row({ tools: ["Read", "Agent", "Workflow"] }, name)).toEqual({ name, on: false });
      expect(row({ subagents: true }, name)).toEqual({ name, on: true });
      expect(row({ subagents: true, tools: ["Read", "Agent", "Workflow"] }, name)).toEqual({
        name,
        on: true,
      });
    }
    // With subagents the lists decide, as for any other tool.
    expect(row({ subagents: true, deny_tools: ["Workflow"] }, "Agent")?.on).toBe(true);
    expect(row({ subagents: true, deny_tools: ["Workflow"] }, "Workflow")?.on).toBe(false);
    expect(row({ subagents: true, tools: ["Read"] }, "Agent")?.on).toBe(false);
    expect(row({ subagents: true, deny: ["Agent"] }, "Agent")?.on).toBe(false);
    // Other tools do not depend on it.
    expect(row({}, "Bash")?.on).toBe(true);
  });
});

describe("applyToolChanges", () => {
  const apply = (
    caps: Parameters<typeof applyToolChanges>[0],
    ...changes: Parameters<typeof applyToolChanges>[1]
  ) => applyToolChanges(caps, changes, sources);

  test("keeps an allow list an allow list and a deny list a deny list", () => {
    expect(apply({ tools: ["Read", "Bash"] }, { kind: "tool", name: "Bash", on: false })).toEqual({
      tools: ["Read"],
    });
    expect(apply({ tools: ["Read"] }, { kind: "tool", name: "Edit", on: true })).toEqual({
      tools: ["Read", "Edit"],
    });
    expect(apply({}, { kind: "tool", name: "Bash", on: false })).toEqual({ deny_tools: ["Bash"] });
    expect(apply({ deny_tools: ["Bash"] }, { kind: "tool", name: "Bash", on: true })).toEqual({
      deny_tools: [],
    });
  });

  test("a tool that is in no list of the session gets the list written out with it", () => {
    const defaults = [
      "Read",
      "Edit",
      "Write",
      "Bash",
      "Glob",
      "Grep",
      "Skill",
      "AskUserQuestion",
      "ExitPlanMode",
    ];
    expect(apply({}, { kind: "tool", name: "WebSearch", on: true })).toEqual({
      tools: [...defaults, "WebSearch"],
    });
    // What was taken away is taken out of the list, and its key goes: a file holds one list.
    const folded = apply({ deny_tools: ["Edit"] }, { kind: "tool", name: "WebSearch", on: true });
    expect(folded.tools).toEqual([...defaults.filter((name) => name !== "Edit"), "WebSearch"]);
    expect("deny_tools" in folded).toBe(true);
    expect(folded.deny_tools).toBeUndefined();
    // A default tool that was taken away only comes back.
    expect(apply({ deny_tools: ["Edit"] }, { kind: "tool", name: "Edit", on: true })).toEqual({
      deny_tools: [],
    });
    // With "every tool" there is no list to write: tools are taken away and given back.
    expect(apply({ tools: ["*"] }, { kind: "tool", name: "WebSearch", on: false })).toEqual({
      deny_tools: ["WebSearch"],
    });
    expect(
      apply(
        { tools: ["*"], deny_tools: ["WebSearch"] },
        { kind: "tool", name: "WebSearch", on: true },
      ),
    ).toEqual({ deny_tools: [] });
  });

  test("switching a subagent tool on sets subagents and keeps the other one off", () => {
    expect(apply({}, { kind: "tool", name: "Agent", on: true })).toEqual({
      subagents: true,
      deny_tools: ["Workflow"],
    });
    expect(apply({ deny_tools: ["Edit"] }, { kind: "tool", name: "Workflow", on: true })).toEqual({
      subagents: true,
      deny_tools: ["Edit", "Agent"],
    });
    expect(apply({ subagents: false }, { kind: "tool", name: "Agent", on: true })).toEqual({
      subagents: true,
      deny_tools: ["Workflow"],
    });
    // Both switched on: neither stays denied.
    const both = apply(
      {},
      { kind: "tool", name: "Agent", on: true },
      { kind: "tool", name: "Workflow", on: true },
    );
    expect(both.subagents).toBe(true);
    expect(both.deny_tools ?? []).toEqual([]);
    // An allow list stays one and names only the tool that was asked for.
    expect(apply({ tools: ["Read"] }, { kind: "tool", name: "Agent", on: true })).toEqual({
      subagents: true,
      tools: ["Read", "Agent"],
    });
  });

  test("what the dialog shows after such a switch is what was asked for", () => {
    const caps = { deny_tools: ["Edit"] };
    const next = { ...caps, ...apply(caps, { kind: "tool", name: "Agent", on: true }) };
    const on = (name: string) =>
      toolView(next, {}, { ...sources, seen: ["Workflow"] }).tools.find(
        (tool) => tool.name === name,
      )?.on;
    expect(on("Agent")).toBe(true);
    expect(on("Workflow")).toBe(false);
    expect(on("Edit")).toBe(false);
  });

  test("with subagents on, the subagent tools switch like any other tool", () => {
    expect(
      apply(
        { subagents: true, deny_tools: ["Workflow"] },
        { kind: "tool", name: "Workflow", on: true },
      ),
    ).toEqual({ deny_tools: [] });
    expect(apply({ subagents: true }, { kind: "tool", name: "Agent", on: false })).toEqual({
      deny_tools: ["Agent"],
    });
    // Other tools never touch the setting.
    expect(apply({}, { kind: "tool", name: "Edit", on: true })).toEqual({});
  });

  test("allowing a tool lifts a deny rule that names it", () => {
    expect(
      apply({ deny: ["Bash", "Read(.env)"] }, { kind: "tool", name: "Bash", on: true }),
    ).toEqual({
      deny: ["Read(.env)"],
    });
  });

  test("switches catalogue servers through mcp and project servers through off_mcp", () => {
    expect(
      apply(
        { mcp: ["github"] },
        { kind: "server", name: "github", on: false },
        { kind: "server", name: "docs", on: true },
        { kind: "server", name: "notes", on: false },
        { kind: "server", name: "dwa", on: false },
      ),
    ).toEqual({ mcp: ["docs"], off_mcp: ["notes"] });
    expect(apply({ off_mcp: ["notes"] }, { kind: "server", name: "notes", on: true })).toEqual({
      off_mcp: [],
    });
  });

  test("blocks a single server tool with a deny rule and edits rule lists", () => {
    expect(
      apply(
        { allow: ["Bash(ls *)"] },
        { kind: "server-tool", server: "github", name: "create_issue", on: false },
        { kind: "rule", list: "deny", rule: "Bash(rm *)", on: true },
        { kind: "rule", list: "allow", rule: "Bash(ls *)", on: false },
      ),
    ).toEqual({ allow: [], deny: ["mcp__github__create_issue", "Bash(rm *)"] });
  });

  test("returns nothing for a change that is already the case", () => {
    expect(apply({ deny_tools: ["Bash"] }, { kind: "tool", name: "Bash", on: false })).toEqual({});
  });
});

describe("layers", () => {
  const config = parseConfig('[defaults]\nmodel = "sonnet"\ndeny = ["Read(.env)"]\n', "test");
  const ctx = {
    projectRoot: "/project",
    env: {},
    files: testRoleFiles({
      explore: 'tools = ["Read", "Bash"]\npermission_mode = "dontAsk"\n',
      reviewer: 'extends = "explore"\nmodel = "opus"\n',
    }),
  };

  test("records where each value comes from", () => {
    const { origins, caps } = resolveLayers({ config, role: "reviewer" }, ctx);
    expect(origins).toEqual({
      model: "role reviewer",
      deny: "defaults",
      tools: "role explore",
      permission_mode: "role explore",
    });
    expect(caps.model).toBe("opus");
  });

  test("lays the run's role values under the session's own, and the agent's on top", () => {
    const request = {
      config,
      role: "reviewer",
      roleRun: { tools: ["Read"], model: "haiku" },
      overrides: { model: "sonnet" },
      agent: { deny: ["Bash(rm *)"] },
    };
    const { origins } = resolveLayers(request, ctx);
    expect(origins).toMatchObject({ tools: "run", model: "session", deny: "agent" });
    expect(resolveSession(request, ctx)).toMatchObject({
      tools: ["Read"],
      model: "sonnet",
      deny: ["Bash(rm *)"],
      offMcp: [],
    });
  });

  test("an agent may add to off_mcp but nothing wider", () => {
    const session = resolveSession(
      { config, role: "explore", overrides: { off_mcp: ["notes"] }, narrowOnly: true },
      ctx,
    );
    expect(session.offMcp).toEqual(["notes"]);
  });
});

describe("liveBlocks", () => {
  const base: ResolvedSession = {
    role: "explore",
    tools: ["Read", "Bash"],
    denyTools: [],
    allow: [],
    deny: ["Read(.env)"],
    mcp: { github: { command: "gh-mcp", args: [], env: {} } },
    plugins: [],
    hiddenSkills: [],
    offMcp: [],
    offPlugins: [],
    offSkills: [],
    allowedSkills: [],
    memory: false,
  };
  const open: ResolvedSession = { ...base, tools: undefined };

  test("what was only taken away can be refused in the running session", () => {
    expect(liveBlocks(base, base)).toEqual([]);
    expect(liveBlocks(base, { ...base, tools: ["Read"] })).toEqual(["Bash"]);
    expect(liveBlocks(open, { ...open, denyTools: ["Edit"] })).toEqual(["Edit"]);
    expect(
      liveBlocks(base, {
        ...base,
        mcp: {},
        offMcp: ["notes"],
        deny: ["Read(.env)", "mcp__github__create_issue", "Write"],
      }),
    ).toEqual(["Write", "mcp__github", "mcp__github__create_issue", "mcp__notes"]);
    // A session stored before off_mcp existed has no such list.
    const old = { ...base, offMcp: undefined } as unknown as ResolvedSession;
    expect(liveBlocks(old, base)).toEqual([]);
  });

  test("anything added, a pattern rule or another setting takes a restart", () => {
    expect(liveBlocks(base, { ...base, tools: ["Read", "Bash", "Edit"] })).toBeNull();
    expect(liveBlocks(base, open)).toBeNull();
    expect(liveBlocks({ ...open, denyTools: ["Edit"] }, open)).toBeNull();
    expect(liveBlocks(base, { ...base, deny: [] })).toBeNull();
    expect(liveBlocks(base, { ...base, deny: ["Read(.env)", "Bash(rm *)"] })).toBeNull();
    expect(liveBlocks(base, { ...base, allow: ["Bash(ls *)"] })).toBeNull();
    // A wildcard without brackets is a pattern too; the hook would not match it.
    expect(liveBlocks(base, { ...base, deny: ["Read(.env)", "mcp__github__*"] })).toBeNull();
    expect(liveBlocks(base, { ...base, model: "opus" })).toBeNull();
    expect(liveBlocks(base, { ...base, prompt: "new" })).toBeNull();
    expect(liveBlocks({ ...base, offMcp: ["notes"] }, base)).toBeNull();
    const moved = { github: { command: "other", args: [], env: {} } };
    expect(liveBlocks(base, { ...base, mcp: moved })).toBeNull();
  });

  test("a refused server covers its tools, a refused tool only itself", () => {
    const blocks = ["Bash", "mcp__github", "mcp__notes__search"];
    expect(isBlocked("Bash", blocks)).toBe(true);
    expect(isBlocked("BashOutput", blocks)).toBe(false);
    expect(isBlocked("mcp__github__create_issue", blocks)).toBe(true);
    expect(isBlocked("mcp__githubber__x", blocks)).toBe(false);
    expect(isBlocked("mcp__notes__search", blocks)).toBe(true);
    expect(isBlocked("mcp__notes__write", blocks)).toBe(false);
  });
});
