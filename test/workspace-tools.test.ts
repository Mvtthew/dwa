// The tools dialog's side of the workspace: what it shows, and the three ways a change is
// saved. Role files are real files in a temporary project, since saving writes them.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localVerdict } from "../src/cli/hook.ts";
import { initProject } from "../src/cli/init.ts";
import { Store } from "../src/daemon/db.ts";
import { Workspace } from "../src/daemon/workspace.ts";
import { claudeProvider } from "../src/providers/claude/launch.ts";
import { loadConfig } from "../src/shared/config.ts";
import { readHistory } from "../src/shared/history.ts";
import type { AgentInfo } from "../src/shared/protocol.ts";
import { roleHistory } from "../src/shared/role-edit.ts";
import { FakeTmux } from "./fake-tmux.ts";

let dir: string;
let env: Record<string, string>;
let tmux: FakeTmux;
let store: Store;
let workspace: Workspace;
let clock: number;
/** Timers for giving a session its task; a test runs them by hand. */
const taskTimers: (() => void)[] = [];

const roleText = (name: string) => readFileSync(join(dir, ".dwa", "roles", `${name}.toml`), "utf8");
const argvOf = (agent: AgentInfo) => tmux.panes.get(agent.paneId)?.argv ?? [];
const flag = (agent: AgentInfo, name: string) => {
  const argv = argvOf(agent);
  return argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
};
const respawns = () => tmux.commands("respawn-pane").length;
/** A session reports events as its hooks would. */
const event = (agent: AgentInfo, name: string, input: Record<string, unknown> = {}) =>
  workspace.hook({ agentId: agent.id, event: name, input });
const idle = (agent: AgentInfo) => event(agent, "SessionStart");
const working = (agent: AgentInfo) => event(agent, "UserPromptSubmit");
const block = (name: string) => ({ kind: "tool" as const, name, on: false });
const allow = (name: string) => ({ kind: "tool" as const, name, on: true });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dwa-ws-tools-"));
  env = { XDG_CONFIG_HOME: join(dir, "home"), PATH: process.env.PATH ?? "" };
  initProject(dir, { roles: true });
  appendFileSync(join(dir, ".dwa", "config.toml"), '\n[mcp.github]\ncommand = "sh"\n');
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { notes: { command: "notes-mcp" } } }),
  );
  tmux = new FakeTmux();
  taskTimers.length = 0;
  store = new Store(":memory:");
  clock = 1_000_000;
  let id = 0;
  workspace = new Workspace({
    store,
    run: tmux.run,
    provider: claudeProvider,
    projectRoot: dir,
    socketPath: join(dir, "dwa.sock"),
    selfArgv: ["bun", "/dwa/cli.ts"],
    runDir: join(dir, ".dwa", "run"),
    loadConfig: () => loadConfig(dir, env),
    listTools: async (server) => {
      if ((server as { command?: string }).command === "sh") return ["create_issue", "list_issues"];
      throw new Error("not installed");
    },
    wrapperConfigDir: () => null,
    schedule: () => undefined,
    taskTimer: (run) => taskTimers.push(run),
    env,
    newId: () => `id-${++id}`,
    // Every look at the clock is ten seconds later, so nothing is served from a cache.
    now: () => {
      clock += 10_000;
      return clock;
    },
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("what the dialog shows", () => {
  test("tools, servers of every kind, where values come from and where they can be saved", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ name: "rev", role: "reviewer" });
    event(agent, "PreToolUse", { tool_name: "mcp__notes__search" });
    const info = await workspace.toolsInfo("rev");
    expect(info.agent).toMatchObject({ name: "rev", role: "reviewer", kind: "agent" });
    expect(info.view.mode).toBe("only");
    expect(info.view.origins.tools).toBe("role explore");
    expect(info.view.tools.filter((tool) => tool.on).map((tool) => tool.name)).toEqual([
      "Bash",
      "Read",
      // Not in the role's list, but a role with skills gets it at launch.
      "Skill",
      "Glob",
      "Grep",
    ]);
    expect(info.view.tools.find((tool) => tool.name === "Skill")?.fixed).toBe(
      "needed for its skills",
    );
    expect(info.view.servers).toEqual([
      { name: "dwa", on: true, fixed: "always on", from: "dwa", tools: null },
      // Not installed here, but one of its tools was seen in use.
      { name: "notes", on: true, from: "project", tools: [{ name: "search", on: true }] },
      {
        name: "github",
        on: false,
        from: "catalogue",
        tools: [
          { name: "create_issue", on: true },
          { name: "list_issues", on: true },
        ],
      },
    ]);
    expect(info.files.map((entry) => entry.file)).toEqual([
      { kind: "role", name: "reviewer", source: "project" },
      { kind: "role", name: "explore", source: "project" },
      { kind: "defaults" },
      { kind: "defaults", source: "user" },
    ]);
    // Every target says which place its file is in.
    expect(info.files.map((entry) => entry.label)).toEqual([
      "Role reviewer  (project)",
      "Role explore  (project; reviewer starts from it; changes both)",
      "[defaults] in the project's config.toml  (every role without its own value)",
      "Personal defaults  (your config.toml, for every project; the project's values win)",
    ]);
    expect(info.outOfDate).toBe(false);
    expect((await workspace.toolsInfo("main")).agent.kind).toBe("main");
  });
});

describe("save for one session", () => {
  test("taking a tool away needs no restart: the hook refuses it from then on", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ name: "ex", role: "explore" });
    working(agent);
    const result = await workspace.saveTools({
      target: "ex",
      changes: [block("Bash"), { kind: "server", name: "notes", on: false }],
      scope: "agent",
    });
    expect(result.applied).toBe("live");
    expect(respawns()).toBe(0);
    // The list is also in the session's folder, where its hook reads it without the daemon.
    expect(localVerdict(dir, agent.id, "Bash")).toContain("Bash was switched off");
    expect(localVerdict(dir, agent.id, "Read")).toBeNull();
    expect(event(agent, "PreToolUse", { tool_name: "Bash" }).deny).toContain("switched off");
    expect(event(agent, "PreToolUse", { tool_name: "mcp__notes__search" }).deny).toBeDefined();
    expect(event(agent, "PreToolUse", { tool_name: "Read" })).toEqual({});

    const state = await workspace.state();
    expect(state.agents[0]?.capabilities?.deny).toEqual(["Bash", "mcp__notes"]);
    expect(state.agents[0]?.outOfDate).toBeUndefined();
    const view = (await workspace.toolsInfo("ex")).view;
    expect(view.tools.find((tool) => tool.name === "Bash")?.on).toBe(false);
    expect(view.origins.tools).toBe("agent");

    // Only this session: the next explore agent has Bash.
    const other = await workspace.spawn({ name: "ex2", role: "explore" });
    expect(flag(other, "--tools")).toBe("Read,Grep,Glob,Bash,WaitForMcpServers");

    // Giving it back is live too, because the session never lost the tool itself.
    const back = await workspace.saveTools({
      target: "ex",
      changes: [allow("Bash")],
      scope: "agent",
    });
    expect(back.applied).toBe("live");
    expect(localVerdict(dir, agent.id, "Bash")).toBeNull();
    expect(event(agent, "PreToolUse", { tool_name: "Bash" })).toEqual({});
    expect(respawns()).toBe(0);
  });

  test("adding a tool restarts an idle session with its conversation, and tells it", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ name: "ex", role: "explore" });
    working(agent);
    event(agent, "Stop");
    const sessionId = flag(agent, "--session-id");
    const result = await workspace.saveTools({
      target: "ex",
      changes: [allow("Edit")],
      scope: "agent",
    });
    expect(result.applied).toBe("restarted");
    expect(respawns()).toBe(1);
    const argv = argvOf(agent);
    expect(argv).not.toContain("--session-id");
    expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 4)).toEqual([
      "--resume",
      sessionId as string,
      "--system-prompt-snapshot",
      "off",
    ]);
    expect(flag(agent, "--tools")).toBe("Read,Grep,Glob,Bash,Edit,WaitForMcpServers");
    // Same pane, same agent.
    const state = await workspace.state();
    expect(state.agents.map((entry) => [entry.id, entry.paneId, entry.activity])).toEqual([
      [agent.id, agent.paneId, "starting"],
    ]);
    expect(state.agents[0]?.capabilities?.tools).toContain("Edit");
    // The note waits until the new process reports in, so the old one cannot swallow it.
    expect(store.pendingMessages(agent.id)).toEqual([]);
    idle(agent);
    const note = store
      .pendingMessages(agent.id)
      .map((message) => message.body)
      .join("\n");
    expect(note).toContain("restarted this session");
    expect(note).toContain("built-in tools: only Read, Grep, Glob, Bash, Edit");
    expect(note).toContain("MCP servers: dwa, notes (the dwa tools work as before)");
  });

  test("a session without a conversation yet is started afresh, not resumed", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ name: "ex", role: "explore" });
    idle(agent);
    const first = flag(agent, "--session-id");
    expect(await workspace.restart("ex")).toBe("restarted");
    expect(argvOf(agent)).not.toContain("--resume");
    const second = flag(agent, "--session-id");
    expect(second).not.toBe(first);
    expect((await workspace.state()).agents[0]?.sessionId).toBe(second as string);
    idle(agent);
    expect(store.pendingMessages(agent.id)).toEqual([]);

    // One that was given a task and restarted before it took it up gets the task again.
    const tasked = await workspace.spawn({ name: "t", role: "explore", task: "count the files" });
    taskTimers.length = 0;
    await workspace.restart("t");
    expect(argvOf(tasked)).not.toContain("count the files");
    taskTimers[0]?.();
    await Bun.sleep(400);
    expect(tmux.commands("set-buffer").at(-1)?.at(-1)).toBe("count the files");
  });

  test("a restart works for a session with a dwa skill, and a failed one leaves nothing saved", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ name: "rev", role: "reviewer" });
    working(agent);
    event(agent, "Stop");
    expect(await workspace.restart("rev")).toBe("restarted");
    expect(await workspace.restart("rev")).toBe("restarted");

    // The role stops resolving: the change cannot be applied, so it is not kept either.
    writeFileSync(join(dir, ".dwa", "roles", "explore.toml"), "tools = 1\n");
    expect(
      workspace.saveTools({ target: "rev", changes: [allow("Edit")], scope: "agent" }),
    ).rejects.toThrow();
    expect(store.getOverrides(agent.id)).toBeNull();
  });

  test("giving a refused tool back tells the session, and a refused server is named", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ name: "ex", role: "explore" });
    idle(agent);
    const off = { kind: "server" as const, name: "notes", on: false };
    await workspace.saveTools({ target: "ex", changes: [block("Bash"), off], scope: "agent" });
    expect(event(agent, "PreToolUse", { tool_name: "mcp__notes__search" }).deny).toContain(
      "The MCP server notes was switched off",
    );
    expect(store.pendingMessages(agent.id)).toEqual([]);
    await workspace.saveTools({ target: "ex", changes: [allow("Bash")], scope: "agent" });
    expect(store.pendingMessages(agent.id).map((message) => message.body)).toEqual([
      "dwa: you can use Bash again in this session. No reply is needed.",
    ]);
  });

  test("saving for the role also reaches a session that has its own value for the list", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ name: "ex", role: "explore" });
    idle(agent);
    await workspace.saveTools({
      target: "ex",
      changes: [allow("Edit")],
      scope: "agent",
      when: "now",
    });
    const result = await workspace.saveTools({
      target: "ex",
      changes: [block("Glob")],
      scope: "run",
    });
    expect(result.applied).toBe("live");
    expect(event(agent, "PreToolUse", { tool_name: "Glob" }).deny).toBeDefined();
    const next = await workspace.spawn({ name: "ex2", role: "explore" });
    expect(flag(next, "--tools")).toBe("Read,Grep,Bash,WaitForMcpServers");
  });

  test("a working session is not interrupted unless told to; it can restart when its turn ends", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ name: "ex", role: "explore" });
    working(agent);
    const request = { target: "ex", changes: [allow("Edit")], scope: "agent" as const };
    expect(await workspace.saveTools(request)).toMatchObject({ applied: "ask", reason: "working" });
    // Nothing was stored by the question.
    expect((await workspace.toolsInfo("ex")).view.tools.find((t) => t.name === "Edit")?.on).toBe(
      false,
    );

    expect((await workspace.saveTools({ ...request, when: "turn-end" })).applied).toBe("pending");
    expect(respawns()).toBe(0);
    expect((await workspace.state()).agents[0]?.pendingRestart).toBe(true);
    event(agent, "Stop");
    const state = await workspace.state();
    expect(respawns()).toBe(1);
    expect(state.agents[0]?.pendingRestart).toBeUndefined();
    expect(flag(agent, "--tools")).toBe("Read,Grep,Glob,Bash,Edit,WaitForMcpServers");

    working(agent);
    const now = await workspace.saveTools({
      target: "ex",
      changes: [{ kind: "rule", list: "deny", rule: "Bash(rm *)", on: true }],
      scope: "agent",
      when: "now",
    });
    expect(now.applied).toBe("restarted");
    expect(respawns()).toBe(2);
  });

  test("the main session asks before it restarts", async () => {
    const state = await workspace.up();
    const main = state.main as AgentInfo;
    idle(main);
    const request = {
      target: "main",
      changes: [{ kind: "server" as const, name: "github", on: true }],
      scope: "agent" as const,
    };
    expect(await workspace.saveTools(request)).toMatchObject({ applied: "ask", reason: "main" });
    expect((await workspace.saveTools({ ...request, when: "now" })).applied).toBe("restarted");
    expect(readFileSync(flag(main, "--mcp-config") as string, "utf8")).toContain('"github"');
    // A live change does not ask.
    expect(
      (await workspace.saveTools({ target: "main", changes: [block("WebSearch")], scope: "agent" }))
        .applied,
    ).toBe("live");
  });
});

describe("save for the role until the workspace stops", () => {
  test("later agents of the role get it, other roles and the next run do not", async () => {
    await workspace.up();
    const first = await workspace.spawn({ name: "ex", role: "explore" });
    const running = await workspace.spawn({ name: "ex-old", role: "explore" });
    idle(first);
    const result = await workspace.saveTools({
      target: "ex",
      changes: [block("Bash")],
      scope: "run",
    });
    expect(result.applied).toBe("live");
    // The other running explore agent is behind, and said to be.
    expect(result.behind.map((session) => session.name)).toEqual(["ex-old"]);
    expect(event(running, "PreToolUse", { tool_name: "Bash" })).toEqual({});

    const next = await workspace.spawn({ name: "ex-new", role: "explore" });
    expect(flag(next, "--tools")).toBe("Read,Grep,Glob,WaitForMcpServers");
    const reviewer = await workspace.spawn({ name: "rev", role: "reviewer" });
    expect(flag(reviewer, "--tools")).toBe("Read,Grep,Glob,Bash,Skill,WaitForMcpServers");
    expect(roleText("explore")).toContain('tools = ["Read", "Grep", "Glob", "Bash"]');

    await workspace.down();
    await workspace.up();
    const fresh = await workspace.spawn({ name: "ex", role: "explore" });
    expect(flag(fresh, "--tools")).toBe("Read,Grep,Glob,Bash,WaitForMcpServers");

    // The main session has no agents coming after it to save for.
    expect(
      workspace.saveTools({ target: "main", changes: [block("Bash")], scope: "run" }),
    ).rejects.toThrow("no role");
  });
});

describe("save globally", () => {
  test("writes the chosen file, keeps its comments, records a version and leaves sessions alone", async () => {
    await workspace.up();
    const reviewer = await workspace.spawn({ name: "rev", role: "reviewer" });
    const explorer = await workspace.spawn({ name: "ex", role: "explore" });
    const developer = await workspace.spawn({ name: "dev", role: "developer" });
    const before = roleText("explore");
    const result = await workspace.saveTools({
      target: "rev",
      changes: [block("Bash")],
      scope: "file",
      file: { kind: "role", name: "explore" },
    });
    expect(roleText("explore")).toBe(
      before.replace(
        'tools = ["Read", "Grep", "Glob", "Bash"]',
        'tools = ["Read", "Grep", "Glob"]',
      ),
    );
    expect(result.version).toBe(2);
    const history = readHistory(roleHistory("explore", { projectRoot: dir, env }));
    expect(history.versions.map((version) => version.source)).toEqual([
      "first version",
      "tools dialog",
    ]);
    // Both roles that use the value are behind; the developer is not.
    expect(result.behind.map((session) => session.name).sort()).toEqual(["ex", "rev"]);
    expect(result.note).toBeUndefined();
    expect(respawns()).toBe(0);
    expect(event(reviewer, "PreToolUse", { tool_name: "Bash" })).toEqual({});
    const state = await workspace.state();
    expect(state.agents.map((agent) => [agent.name, agent.outOfDate ?? false])).toEqual([
      ["rev", true],
      ["ex", true],
      ["dev", false],
    ]);

    // Bringing the ticked ones up to date: a removed tool needs no restart.
    const refreshed = await workspace.refresh({ targets: [reviewer.id], when: "now" });
    expect(refreshed.results).toEqual([{ name: "rev", applied: "live" }]);
    expect(event(reviewer, "PreToolUse", { tool_name: "Bash" }).deny).toBeDefined();
    expect(event(explorer, "PreToolUse", { tool_name: "Bash" })).toEqual({});
    expect((await workspace.state()).agents.map((agent) => agent.outOfDate ?? false)).toEqual([
      false,
      true,
      false,
    ]);
    void developer;
  });

  test("into the role itself when the value is inherited, and into [defaults]", async () => {
    await workspace.up();
    await workspace.spawn({ name: "rev", role: "reviewer" });
    await workspace.saveTools({
      target: "rev",
      changes: [block("Bash")],
      scope: "file",
      file: { kind: "role", name: "reviewer" },
    });
    expect(roleText("reviewer")).toContain('tools = ["Read", "Grep", "Glob"]\n\nprompt = """');
    expect(roleText("explore")).toContain('"Bash"]');

    const result = await workspace.saveTools({
      target: "rev",
      changes: [block("WebSearch")],
      scope: "file",
      file: { kind: "defaults" },
    });
    const config = readFileSync(join(dir, ".dwa", "config.toml"), "utf8");
    expect(config).toContain('deny_tools = ["WebSearch"]');
    // The reviewer is behind from the save before; main now is too, by the new default.
    expect(result.behind.map((session) => session.name)).toEqual(["rev", "main"]);
    // The reviewer never had WebSearch, so for it the switch is as asked.
    expect(result.note).toBeUndefined();

    // The developer role has deny rules of its own, so one in the defaults does not reach it.
    await workspace.spawn({ name: "dev", role: "developer" });
    const rule = await workspace.saveTools({
      target: "dev",
      changes: [{ kind: "rule", list: "deny", rule: "Bash(rm *)", on: true }],
      scope: "file",
      file: { kind: "defaults" },
    });
    expect(rule.note).toContain("does not reach dev");
    const again = await workspace.saveTools({
      target: "rev",
      changes: [block("WebSearch")],
      scope: "file",
      file: { kind: "defaults" },
    });
    expect(again.note).toContain("already says so");
  });

  test("a file changed by hand marks its sessions, and a restart brings it along", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ name: "dev", role: "developer" });
    idle(agent);
    expect((await workspace.state()).agents[0]?.outOfDate).toBeUndefined();
    writeFileSync(
      join(dir, ".dwa", "roles", "developer.toml"),
      roleText("developer").replace('model = "sonnet"', 'model = "opus"'),
    );
    expect((await workspace.state()).agents[0]?.outOfDate).toBe(true);
    expect((await workspace.toolsInfo("dev")).outOfDate).toBe(true);
    expect(await workspace.restart("dev")).toBe("restarted");
    expect(flag(agent, "--model")).toBe("opus");
    expect((await workspace.state()).agents[0]?.outOfDate).toBeUndefined();
  });
});
