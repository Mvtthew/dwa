import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/daemon/db.ts";
import { Workspace, WorkspaceError } from "../src/daemon/workspace.ts";
import { claudeProvider } from "../src/providers/claude/launch.ts";
import type { Config } from "../src/shared/config.ts";
import { WORKSPACE_WINDOW } from "../src/tmux/layout.ts";
import { FakeTmux } from "./fake-tmux.ts";

const config: Config = {
  keys: {},
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

beforeEach(() => {
  tmux = new FakeTmux();
  files = new Map();
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
    expect(panes[1]?.argv).toEqual([
      "/bin/claude_me",
      "--session-id",
      "id-2",
      "--name",
      "main",
      "--settings",
      "/project/.dwa/run/agents/id-1/settings.json",
    ]);
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

describe("agents", () => {
  test("spawn starts the agent in the pool, not in the workspace window", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ role: "explore", task: "find the bug" });
    expect(agent.name).toBe("explore");
    expect(agent.open).toBe(false);
    expect(tmux.windowOf(agent.paneId)).toBe("explore");
    expect(tmux.panes.get(agent.paneId)?.argv).toEqual([
      "/bin/claude_me",
      "--session-id",
      "id-4",
      "--name",
      "explore",
      "--settings",
      "/project/.dwa/run/agents/id-3/settings.json",
      "--agent",
      "explore",
      "find the bug",
    ]);
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
