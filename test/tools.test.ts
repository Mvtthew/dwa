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

  test("shows denied tools, servers of every kind and the rules", () => {
    const view = toolView(
      {
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
    expect(view.tools.filter((tool) => !tool.on).map((tool) => tool.name)).toEqual([
      "Bash",
      "Edit",
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
