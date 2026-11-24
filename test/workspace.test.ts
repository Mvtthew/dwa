import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/daemon/db.ts";
import { Workspace, WorkspaceError } from "../src/daemon/workspace.ts";
import { claudeProvider } from "../src/providers/claude/launch.ts";
import type { Config } from "../src/shared/config.ts";
import { WORKSPACE_WINDOW } from "../src/tmux/layout.ts";
import { FakeTmux } from "./fake-tmux.ts";

let config: Config;
const baseConfig: Config = {
  keys: {},
  agents: [],
  layout: {},
  default_profile: "me",
  profiles: {
    me: { command: "/bin/claude_me", args: [], env: {} },
    work: { command: "/bin/claude_work", args: ["--verbose"], env: { TEAM: "x" } },
  },
};

let tmux: FakeTmux;
let store: Store;
let workspace: Workspace;
let files: Map<string, string>;
/** Paste-fallback timers the workspace asked for; a test runs them by hand. */
let scheduled: (() => void)[];

beforeEach(() => {
  config = structuredClone(baseConfig);
  tmux = new FakeTmux();
  files = new Map();
  scheduled = [];
  store = new Store(":memory:");
  let id = 0;
  workspace = new Workspace({
    store,
    run: tmux.run,
    provider: claudeProvider,
    projectRoot: "/project",
    socketPath: "/tmp/dwa.sock",
    selfArgv: ["bun", "/dwa/cli.ts"],
    runDir: "/project/.dwa/run",
    writeFile: (path, content) => files.set(path, content),
    loadConfig: async () => config,
    schedule: (callback) => scheduled.push(callback),
    env: {},
    newId: () => `id-${++id}`,
    now: () => 1000 + id,
  });
});

describe("up", () => {
  test("creates the three columns with the main session in the middle", async () => {
    const state = await workspace.up();
    expect(state.up).toBe(true);
    expect(state.main?.name).toBe("main");
    expect(state.main?.profile).toBe("me");
    expect(state.agents).toEqual([]);

    const panes = [...tmux.panes.values()];
    expect(panes.map((pane) => pane.window)).toEqual(Array(3).fill(WORKSPACE_WINDOW));
    expect(panes[0]?.argv).toEqual(["bun", "/dwa/cli.ts", "ui", "status"]);
    const mainArgv = panes[1]?.argv ?? [];
    expect(mainArgv.slice(0, 9)).toEqual([
      "/bin/claude_me",
      "--session-id",
      "id-2",
      "--name",
      "main",
      "--settings",
      "/project/.dwa/run/agents/id-1/settings.json",
      "--mcp-config",
      "/project/.dwa/run/agents/id-1/mcp.json",
    ]);
    expect(mainArgv[9]).toBe("--append-system-prompt");
    expect(mainArgv[10]).toContain('You are "main"');
    expect(mainArgv).toHaveLength(11);
    expect(panes[2]?.argv).toEqual(["bun", "/dwa/cli.ts", "ui", "agents"]);
    expect(panes[1]?.env).toMatchObject({
      DWA_PROJECT: "/project",
      DWA_SOCKET: "/tmp/dwa.sock",
      DWA_AGENT_ID: "id-1",
    });
  });

  test("is a no-op when the workspace is already running", async () => {
    await workspace.up();
    await workspace.up();
    expect(tmux.commands("new-session")).toHaveLength(1);
  });

  test("uses the chosen profile for main and for agents spawned later", async () => {
    await workspace.up({ profile: "work" });
    const agent = await workspace.spawn({ name: "dev" });
    expect(agent.profile).toBe("work");
    const main = [...tmux.panes.values()][1];
    expect(main?.argv.slice(0, 2)).toEqual(["/bin/claude_work", "--verbose"]);
    expect(main?.env.TEAM).toBe("x");
  });

  test("rejects an unknown profile", async () => {
    expect(workspace.up({ profile: "nope" })).rejects.toThrow('Unknown profile "nope"');
  });

  test("starts clean when the main session has exited", async () => {
    const first = await workspace.up();
    const mainPane = tmux.panes.get(first.main?.paneId ?? "");
    if (mainPane) mainPane.dead = true;
    const second = await workspace.up();
    expect(tmux.commands("kill-server")).toHaveLength(1);
    expect(second.main?.sessionId).not.toBe(first.main?.sessionId);
  });
});

describe("config", () => {
  test("agents listed in the config start with the workspace", async () => {
    config.agents = [
      { name: "explore", role: "explore" },
      { name: "rev", role: "reviewer", profile: "work", task: "review HEAD" },
    ];
    const state = await workspace.up();
    expect(
      state.agents.map((agent) => [agent.name, agent.role, agent.profile, agent.task]),
    ).toEqual([
      ["explore", "explore", "me", null],
      ["rev", "reviewer", "work", "review HEAD"],
    ]);
    // A second `up` does not start them again.
    expect((await workspace.up()).agents).toHaveLength(2);
  });

  test("an agent that cannot be started is reported and the rest still start", async () => {
    config.agents = [{ name: "bad name" }, { name: "x", profile: "nope" }, { name: "ok" }];
    const state = await workspace.up();
    expect(state.agents.map((agent) => agent.name)).toEqual(["ok"]);
    const shown = tmux.commands("display-message").map((command) => command.at(-1));
    expect(shown[0]).toContain('Could not start agent "bad name"');
    expect(shown[1]).toContain('Unknown profile "nope"');
  });

  test("layout sizes from the config are applied", async () => {
    config.layout = { status_width: 24, agents_width: 40, agent_height: 55 };
    await workspace.up();
    expect(tmux.commands("resize-pane").map((command) => command.at(-1))).toEqual(["24", "40"]);
    await workspace.spawn({ name: "a" });
    await workspace.open("a");
    expect(tmux.commands("join-pane").at(-1)).toContain("55%");
  });
});

describe("agents", () => {
  test("spawn starts the agent in the pool, not in the workspace window", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ role: "explore", task: "find the bug" });
    expect(agent.name).toBe("explore");
    expect(agent.open).toBe(false);
    expect(tmux.windowOf(agent.paneId)).toBe("explore");
    const argv = tmux.panes.get(agent.paneId)?.argv ?? [];
    expect(argv.slice(0, 5)).toEqual([
      "/bin/claude_me",
      "--session-id",
      "id-4",
      "--name",
      "explore",
    ]);
    expect(argv[6]).toBe("/project/.dwa/run/agents/id-3/settings.json");
    expect(argv[10]).toContain('You are "explore"');
    // The role and the task come last, after everything dwa adds.
    expect(argv.slice(11)).toEqual(["--agent", "explore", "find the bug"]);
  });

  test("a per-agent profile wins over the workspace profile", async () => {
    await workspace.up({ profile: "me" });
    const agent = await workspace.spawn({ name: "dev", profile: "work" });
    expect(agent.profile).toBe("work");
  });

  test("names are made unique and validated", async () => {
    await workspace.up();
    expect((await workspace.spawn({ name: "dev" })).name).toBe("dev");
    expect((await workspace.spawn({ name: "dev" })).name).toBe("dev-2");
    expect((await workspace.spawn()).name).toBe("agent");
    expect(workspace.spawn({ name: "main" })).rejects.toThrow(WorkspaceError);
    expect(workspace.spawn({ name: "has space" })).rejects.toThrow(WorkspaceError);
  });

  test("spawn needs a running workspace", async () => {
    expect(workspace.spawn({ name: "dev" })).rejects.toThrow("not running");
  });

  test("open puts the agent under main, and opening another swaps them", async () => {
    const { main } = await workspace.up();
    const a = await workspace.spawn({ name: "a" });
    const b = await workspace.spawn({ name: "b" });

    await workspace.open("a");
    expect(tmux.windowOf(a.paneId)).toBe(WORKSPACE_WINDOW);
    expect(tmux.commands("join-pane").at(-1)).toEqual([
      "join-pane",
      "-v",
      "-l",
      "40%",
      "-s",
      a.paneId,
      "-t",
      main?.paneId ?? "",
    ]);

    await workspace.open("2");
    expect(tmux.windowOf(a.paneId)).toBe("a");
    expect(tmux.windowOf(b.paneId)).toBe(WORKSPACE_WINDOW);
    expect(tmux.windowOf(main?.paneId ?? "")).toBe(WORKSPACE_WINDOW);

    const state = await workspace.state();
    expect(state.agents.map((agent) => [agent.name, agent.open])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  test("opening the agent that is already open only focuses it", async () => {
    await workspace.up();
    await workspace.spawn({ name: "a" });
    await workspace.open("a");
    await workspace.open("a");
    expect(tmux.commands("join-pane")).toHaveLength(1);
  });

  test("close returns the agent to the pool and keeps it running", async () => {
    await workspace.up();
    const a = await workspace.spawn({ name: "a" });
    await workspace.open("a");
    await workspace.close();
    expect(tmux.windowOf(a.paneId)).toBe("a");
    expect((await workspace.state()).agents).toHaveLength(1);
  });

  test("stop ends the session and removes it from the list", async () => {
    await workspace.up();
    const a = await workspace.spawn({ name: "a" });
    await workspace.spawn({ name: "b" });
    await workspace.stop("a");
    expect(tmux.panes.has(a.paneId)).toBe(false);
    expect((await workspace.state()).agents.map((agent) => agent.name)).toEqual(["b"]);
  });

  test("an agent whose session exited on its own disappears and its pane is removed", async () => {
    await workspace.up();
    const a = await workspace.spawn({ name: "a" });
    const pane = tmux.panes.get(a.paneId);
    if (pane) pane.dead = true;
    expect((await workspace.state()).agents).toEqual([]);
    expect(tmux.panes.has(a.paneId)).toBe(false);
  });

  test("unknown agent names list the running ones", async () => {
    await workspace.up();
    await workspace.spawn({ name: "a" });
    expect(workspace.open("zzz")).rejects.toThrow('No agent "zzz" (running: a)');
  });
});

describe("live state", () => {
  test("a new session is starting and has per-session settings pointing at dwa", async () => {
    const { main } = await workspace.up();
    expect(main).toMatchObject({ activity: "starting", detail: null, telemetry: null });
    const settings = JSON.parse(files.get("/project/.dwa/run/agents/id-1/settings.json") ?? "{}");
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("'bun' '/dwa/cli.ts' hook Stop");
    expect(settings.statusLine.command).toBe("'bun' '/dwa/cli.ts' statusline");
    expect(settings.permissions.allow).toEqual(["mcp__dwa"]);
    // The mailbox hook is armed where a session can go idle, and only there.
    expect(settings.hooks.Stop[0].hooks[1]).toMatchObject({
      command: "'bun' '/dwa/cli.ts' mailbox",
      asyncRewake: true,
    });
    expect(settings.hooks.SessionStart[0].hooks).toHaveLength(2);
    expect(settings.hooks.PreToolUse[0].hooks).toHaveLength(1);
    const mcp = JSON.parse(files.get("/project/.dwa/run/agents/id-1/mcp.json") ?? "{}");
    expect(mcp.mcpServers.dwa).toMatchObject({
      command: "bun",
      args: ["/dwa/cli.ts", "mcp"],
      env: { DWA_AGENT_ID: "id-1", DWA_PROJECT: "/project", DWA_SOCKET: "/tmp/dwa.sock" },
    });
  });

  test("hook events move an agent through working, needs_user and idle", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ name: "dev" });
    const activity = async () => {
      const [dev] = (await workspace.state()).agents;
      return [dev?.activity, dev?.detail];
    };
    const send = (event: string, input: unknown = {}) =>
      workspace.hook({ agentId: agent.id, event, input });

    send("SessionStart");
    expect(await activity()).toEqual(["idle", null]);
    send("UserPromptSubmit", { prompt: "fix it" });
    expect(await activity()).toEqual(["working", null]);
    send("PreToolUse", { tool_name: "Bash" });
    expect(await activity()).toEqual(["working", "Bash"]);
    send("PermissionRequest", { tool_name: "Bash" });
    expect(await activity()).toEqual(["needs_user", "permission: Bash"]);
    send("Notification", { notification_type: "permission_prompt" });
    expect(await activity()).toEqual(["needs_user", "permission: Bash"]);
    send("PostToolUse", { tool_name: "Bash" });
    expect(await activity()).toEqual(["working", null]);
    send("Stop", { last_assistant_message: "\nAll done.\nDetails follow." });
    expect(await activity()).toEqual(["idle", "All done."]);
    send("StopFailure", { error: "Login expired" });
    expect(await activity()).toEqual(["error", "Login expired"]);

    expect(store.recentEvents(2).map((event) => event.event)).toEqual(["StopFailure", "Stop"]);
  });

  test("events for unknown or stopped agents are ignored", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ name: "dev" });
    await workspace.stop("dev");
    workspace.hook({ agentId: agent.id, event: "Stop", input: {} });
    workspace.hook({ agentId: "nope", event: "Stop", input: null });
    expect(store.recentEvents(10)).toEqual([]);
  });

  test("statusline data becomes telemetry", async () => {
    const { main } = await workspace.up();
    workspace.statusline({
      agentId: main?.id ?? "",
      data: {
        model: { id: "claude-fable-5-2", display_name: "Fable 5.2" },
        context_window: { used_percentage: 41 },
        cost: { total_cost_usd: 0.7 },
        rate_limits: {
          five_hour: { used_percentage: 9, resets_at: 1795559400 },
          seven_day: { used_percentage: 12, resets_at: 1795766400 },
        },
      },
    });
    expect((await workspace.state()).main?.telemetry).toMatchObject({
      contextPercent: 41,
      costUsd: 0.7,
      model: "Fable 5.2",
      fiveHour: { usedPercent: 9, resetsAt: 1795559400 },
      sevenDay: { usedPercent: 12, resetsAt: 1795766400 },
    });
  });

  test("missing statusline fields are null, not guessed", async () => {
    const { main } = await workspace.up();
    workspace.statusline({ agentId: main?.id ?? "", data: { context_window: {} } });
    expect((await workspace.state()).main?.telemetry).toMatchObject({
      contextPercent: null,
      costUsd: null,
      model: null,
      fiveHour: null,
      sevenDay: null,
    });
  });
});

describe("messaging", () => {
  async function team() {
    const { main } = await workspace.up();
    const dev = await workspace.spawn({ name: "dev" });
    const rev = await workspace.spawn({ name: "rev" });
    return { main: main?.id ?? "", dev: dev.id, rev: rev.id, m: workspace.messaging };
  }

  test("a message reaches the recipient's waiting mailbox hook", async () => {
    const { dev, rev, m } = await team();
    const mailbox = m.waitMailbox(rev);
    expect(m.send(dev, "rev", "tests are green")).toMatchObject({ to: "rev" });
    expect(await mailbox).toEqual(['[dwa] Message from agent "dev":\ntests are green']);
    expect(store.pendingMessages(rev)).toEqual([]);
  });

  test("a message sent while no hook waits is handed to the next one", async () => {
    const { dev, rev, m } = await team();
    m.send("user", "rev", "please stop");
    m.send(dev, "rev", "second");
    expect(await m.waitMailbox(rev)).toEqual([
      "[dwa] Message from the user:\nplease stop",
      '[dwa] Message from agent "dev":\nsecond',
    ]);
  });

  test("a newer mailbox hook replaces the older one", async () => {
    const { rev, m } = await team();
    const first = m.waitMailbox(rev);
    const second = m.waitMailbox(rev);
    expect(await first).toEqual([]);
    m.send("user", "rev", "hi");
    expect(await second).toHaveLength(1);
  });

  test("a hook that disconnects is forgotten, so its messages are not lost", async () => {
    const { rev, m } = await team();
    const abort = new AbortController();
    void m.waitMailbox(rev, abort.signal);
    abort.abort();
    m.send("user", "rev", "hi");
    expect(store.pendingMessages(rev)).toHaveLength(1);
  });

  test("without a hook, a message is pasted into an idle session and queued for a busy one", async () => {
    const { rev, m } = await team();
    workspace.hook({ agentId: rev, event: "UserPromptSubmit", input: {} });
    m.send("user", "rev", "hello");
    await scheduled.shift()?.();
    await Bun.sleep(0);
    expect(tmux.commands("paste-buffer")).toHaveLength(0);
    expect(store.pendingMessages(rev)).toHaveLength(1);

    workspace.hook({ agentId: rev, event: "Stop", input: {} });
    m.flush(rev);
    scheduled.at(-1)?.();
    await Bun.sleep(400);
    expect(tmux.commands("set-buffer").at(-1)?.at(-1)).toBe("[dwa] Message from the user:\nhello");
    expect(tmux.commands("paste-buffer")).toHaveLength(1);
    expect(tmux.commands("send-keys").at(-1)?.at(-1)).toBe("Enter");
    expect(store.pendingMessages(rev)).toEqual([]);
  });

  test("messages to the user land in the inbox", async () => {
    const { dev, m } = await team();
    m.send(dev, "user", "done with the fix");
    const state = await workspace.state();
    expect(state.inbox.map((entry) => [entry.from, entry.body])).toEqual([
      ["dev", "done with the fix"],
    ]);
  });

  test("ask blocks until the addressed agent answers", async () => {
    const { dev, rev, m } = await team();
    const mailbox = m.waitMailbox(rev);
    const question = m.ask(dev, "rev", "merge now?", ["yes", "no"]);
    expect((await mailbox)[0]).toContain(`Question #${question.id}: merge now?`);

    let settled = false;
    const waiting = m.waitQuestion(question.id).then((result) => {
      settled = true;
      return result;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    const state = await workspace.state();
    expect(state.agents.find((agent) => agent.name === "dev")?.waitingOn).toBe("rev");
    expect(state.questions).toMatchObject([{ from: "dev", to: "rev", options: ["yes", "no"] }]);

    m.answer(question.id, rev, "yes");
    expect(await waiting).toMatchObject({ state: "answered", answer: "yes", answeredBy: rev });
    expect((await workspace.state()).questions).toEqual([]);
  });

  test("the user can answer any question; other agents cannot", async () => {
    const { main, dev, m } = await team();
    const question = m.ask(dev, "rev", "merge now?", null);
    expect(() => m.answer(question.id, main, "yes")).toThrow("not addressed to you");
    expect(m.answer(question.id, "user", "no")).toMatchObject({ answer: "no" });
    expect(() => m.answer(question.id, "user", "again")).toThrow("already answered");
  });

  test("a question to the user stays open across waits and is answered later", async () => {
    const { dev, m } = await team();
    const question = m.ask(dev, "user", "which database?", null);
    const interrupted = new AbortController();
    void m.waitQuestion(question.id, interrupted.signal);
    interrupted.abort();
    // The agent's tool call ended, but the question is still there.
    expect((await workspace.state()).questions).toHaveLength(1);
    m.answer(question.id, "user", "postgres");
    // Nobody was waiting on the call any more, so the answer is sent as a message instead.
    expect(await m.waitMailbox(dev)).toEqual([
      '[dwa] Message from the user:\nAnswer to your question #1 ("which database?"): postgres',
    ]);
    expect(await m.waitQuestion(question.id)).toMatchObject({ state: "answered" });
  });

  test("stopping an agent cancels the questions it was part of", async () => {
    const { dev, m } = await team();
    const toRev = m.ask(dev, "rev", "ok?", null);
    const waiting = m.waitQuestion(toRev.id);
    await workspace.stop("rev");
    expect(await waiting).toMatchObject({
      state: "cancelled",
      answer: "rev stopped before answering",
    });
  });

  test("bad requests are refused with a clear message", async () => {
    const { dev, m } = await team();
    expect(() => m.send(dev, "nobody", "x")).toThrow('No running agent "nobody"');
    expect(() => m.send(dev, "dev", "x")).toThrow("yourself");
    expect(() => m.send(dev, "rev", "  ")).toThrow("empty");
    expect(() => m.answer(99, "user", "x")).toThrow("no question #99");
  });

  test("progress notes are stored on the agent", async () => {
    const { dev } = await team();
    workspace.progress(dev, "running the test suite\nmore", 40);
    const state = await workspace.state();
    expect(state.agents.find((agent) => agent.name === "dev")?.progress).toBe(
      "40% running the test suite",
    );
  });
});

describe("notify", () => {
  test("shows a message and does not fail when no terminal is attached", async () => {
    await workspace.up();
    await workspace.notify("No agent at position 1");
    expect(tmux.commands("display-message").at(-1)).toEqual([
      "display-message",
      "-d",
      "3000",
      "No agent at position 1",
    ]);
    const failing = new Workspace({
      store,
      run: async () => {
        throw new Error("no current client");
      },
      provider: claudeProvider,
      projectRoot: "/project",
      socketPath: "/tmp/dwa.sock",
      selfArgv: ["bun"],
      runDir: "/project/.dwa/run",
      loadConfig: async () => config,
    });
    await failing.notify("x");
  });
});

describe("down", () => {
  test("kills the server and marks everything stopped", async () => {
    await workspace.up();
    await workspace.spawn({ name: "a" });
    await workspace.down();
    const state = await workspace.state();
    expect(state).toMatchObject({ up: false, main: null, agents: [] });
    expect(store.running()).toEqual([]);
  });

  test("does not fail when nothing is running", async () => {
    await workspace.down();
    expect((await workspace.state()).up).toBe(false);
  });
});
