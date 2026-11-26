import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/daemon/db.ts";
import { Workspace, WorkspaceError } from "../src/daemon/workspace.ts";
import { claudeProvider } from "../src/providers/claude/launch.ts";
import { BUILTIN_SKILLS, DEFAULT_TOOLS } from "../src/shared/capabilities.ts";
import type { Config } from "../src/shared/config.ts";
import { WORKSPACE_WINDOW } from "../src/tmux/layout.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { testRoleFiles } from "./role-files.ts";

let config: Config;
const baseConfig: Config = {
  keys: {},
  agents: [],
  layout: {},
  defaults: {},
  main: {},
  mcp: {},
  plugins: {},
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
/** Links the workspace made, by path, with what each points at. */
let links: Map<string, string>;
/** Paste-fallback timers the workspace asked for; a test runs them by hand. */
let scheduled: (() => void)[];
/** Timers for giving a session its task, with their delay; a test runs them by hand. */
let taskTimers: { run: () => void; ms: number }[];
/** The text of role files; a role not listed here has an empty file. */
let roles: Record<string, string>;
/** Other files the workspace can see, by full path, and the commands on PATH. */
let disk: Record<string, string>;
let commands: string[];

beforeEach(() => {
  config = structuredClone(baseConfig);
  tmux = new FakeTmux();
  files = new Map();
  links = new Map();
  scheduled = [];
  taskTimers = [];
  roles = {};
  disk = {};
  commands = [];
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
    roleFiles: {
      // Looked up on every call, so a test can add files after the workspace is made.
      read: (path) => testRoleFiles(roles, disk, commands).read(path),
      exists: (path) => testRoleFiles(roles, disk, commands).exists(path),
      list: (path) => testRoleFiles(roles, disk, commands).list(path),
      which: (command) => testRoleFiles(roles, disk, commands).which(command),
    },
    linkDir: (target, path) => links.set(path, target),
    wrapperConfigDir: () => "/home/me/.claude-me",
    schedule: (callback) => scheduled.push(callback),
    taskTimer: (run, ms) => taskTimers.push({ run, ms }),
    env: {},
    newId: () => `id-${++id}`,
    now: () => 1000 + id,
  });
});

/** `--tools` of a session that has the default list (the launch adds the tool that waits for servers). */
const DEFAULT_TOOL_LIST = [...DEFAULT_TOOLS, "WaitForMcpServers"].join(",");
/** `skillOverrides` of a session that keeps no built-in skill. */
const builtinOff = Object.fromEntries(BUILTIN_SKILLS.map((name) => [name, "off"]));

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
    expect(mainArgv).toEqual([
      "/bin/claude_me",
      "--setting-sources",
      "project,local",
      "--tools",
      DEFAULT_TOOL_LIST,
      "--session-id",
      "id-2",
      "--name",
      "main",
      "--settings",
      "/project/.dwa/run/agents/id-1/settings.json",
      "--strict-mcp-config",
      "--mcp-config",
      "/project/.dwa/run/agents/id-1/mcp.json",
      "--append-system-prompt-file",
      "/project/.dwa/run/agents/id-1/prompt.md",
    ]);
    expect(files.get("/project/.dwa/run/agents/id-1/prompt.md")).toContain('You are "main"');
    expect(panes[2]?.argv).toEqual(["bun", "/dwa/cli.ts", "ui", "agents"]);
    expect(panes[1]?.env).toMatchObject({
      DWA_PROJECT: "/project",
      DWA_SOCKET: "/tmp/dwa.sock",
      DWA_AGENT_ID: "id-1",
    });
  });

  test("a role that asks for it gets the roles it can hand work to in its prompt", async () => {
    roles = {
      main: 'role_list = true\nin_role_list = false\nprompt = "Lead."',
      explore: 'description = "Reads the code."',
      helper: 'when_to_use = "Odd jobs."',
    };
    await workspace.up();
    const prompt = files.get("/project/.dwa/run/agents/id-1/prompt.md") ?? "";
    expect(prompt).toContain("# Your role: main\n\nLead.\n\n# Roles you can hand work to");
    expect(prompt).toContain("- explore: Reads the code.\n- helper: Odd jobs.");
    expect(prompt).not.toContain("- main");

    const explore = await workspace.spawn({ role: "explore" });
    const other = files.get(`/project/.dwa/run/agents/${explore.id}/prompt.md`) ?? "";
    expect(other).toContain('You are "explore"');
    expect(other).not.toContain("Roles you can hand work to");

    // The list is not part of what the session was started with: another role changing
    // does not make this one out of date.
    roles = { ...roles, helper: 'when_to_use = "Everything."' };
    expect((await workspace.state()).main?.outOfDate).toBeUndefined();
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
    expect(argv.slice(0, 9)).toEqual([
      "/bin/claude_me",
      "--setting-sources",
      "project,local",
      "--tools",
      DEFAULT_TOOL_LIST,
      "--session-id",
      "id-4",
      "--name",
      "explore",
    ]);
    expect(argv[10]).toBe("/project/.dwa/run/agents/id-3/settings.json");
    expect(files.get("/project/.dwa/run/agents/id-3/prompt.md")).toContain('You are "explore"');
    // The task is not a launch argument: it would be taken before the dwa tools are there.
    expect(argv).not.toContain("find the bug");
    expect(agent.task).toBe("find the bug");
  });

  test("the task is typed in once the session's dwa tools have connected", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ role: "explore", task: "find the bug" });
    expect(tmux.commands("paste-buffer")).toHaveLength(0);

    workspace.ready(agent.id);
    // The fallback from the start, then the short wait after the connection.
    expect(taskTimers.map((timer) => timer.ms)).toEqual([20_000, 500]);
    taskTimers[1]?.run();
    await Bun.sleep(400);
    expect(tmux.commands("set-buffer").at(-1)?.at(-1)).toBe("find the bug");
    expect(tmux.commands("paste-buffer").at(-1)).toContain(agent.paneId);
    expect(tmux.commands("send-keys").at(-1)).toEqual(["send-keys", "-t", agent.paneId, "Enter"]);

    // Given once: not again by the fallback, nor when the server connects again.
    taskTimers[0]?.run();
    workspace.ready(agent.id);
    await Bun.sleep(400);
    expect(tmux.commands("paste-buffer")).toHaveLength(1);
    expect(taskTimers).toHaveLength(2);
  });

  test("the task is typed in after a while when the dwa tools never report in", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ role: "explore", task: "find the bug" });
    taskTimers[0]?.run();
    await Bun.sleep(400);
    expect(tmux.commands("set-buffer").at(-1)?.at(-1)).toBe("find the bug");

    // A session without a task waits for nothing, and one that is gone gets nothing.
    const idle = await workspace.spawn({ name: "idle" });
    workspace.ready(idle.id);
    const gone = await workspace.spawn({ name: "gone", task: "too late" });
    await workspace.stop(gone.id);
    for (const timer of taskTimers.slice(1)) timer.run();
    await Bun.sleep(400);
    expect(tmux.commands("paste-buffer")).toHaveLength(1);
    expect(agent.task).toBe("find the bug");
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

  test("toggle shows an agent, hides it again, and swaps with another", async () => {
    const { main } = await workspace.up();
    const a = await workspace.spawn({ name: "a" });
    const b = await workspace.spawn({ name: "b" });

    expect((await workspace.toggle("a")).open).toBe(true);
    expect(tmux.windowOf(a.paneId)).toBe(WORKSPACE_WINDOW);
    expect((await workspace.toggle("b")).open).toBe(true);
    expect(tmux.windowOf(a.paneId)).toBe("a");
    expect(tmux.windowOf(b.paneId)).toBe(WORKSPACE_WINDOW);

    expect((await workspace.toggle("b")).open).toBe(false);
    expect(tmux.windowOf(b.paneId)).toBe("b");
    expect(tmux.commands("select-pane").at(-1)).toEqual(["select-pane", "-t", main?.paneId ?? ""]);
    expect((await workspace.state()).agents.every((agent) => !agent.open)).toBe(true);
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

describe("the shell pane", () => {
  const shellPane = () => store.getMeta("shell_pane") ?? "";

  test("is started on first use under main, then hidden and shown again without restarting", async () => {
    const { main } = await workspace.up();
    expect((await workspace.state()).shell).toBeNull();

    expect(await workspace.toggleShell()).toEqual({ open: true });
    const pane = shellPane();
    expect(tmux.panes.get(pane)?.argv).toEqual(["/bin/sh"]);
    expect(tmux.windowOf(pane)).toBe(WORKSPACE_WINDOW);
    expect(tmux.commands("join-pane").at(-1)).toEqual([
      "join-pane",
      "-v",
      "-l",
      "40%",
      "-s",
      pane,
      "-t",
      main?.paneId ?? "",
    ]);
    expect((await workspace.state()).shell).toEqual({ open: true });

    expect(await workspace.toggleShell()).toEqual({ open: false });
    expect(tmux.windowOf(pane)).toBe("shell");
    expect((await workspace.state()).shell).toEqual({ open: false });

    await workspace.toggleShell();
    expect(shellPane()).toBe(pane);
    expect(tmux.commands("new-window")).toHaveLength(1);
    // It is not an agent.
    expect((await workspace.state()).agents).toEqual([]);
  });

  test("shares the slot under main with the agents", async () => {
    await workspace.up();
    const a = await workspace.spawn({ name: "a" });
    await workspace.open("a");
    await workspace.toggleShell();
    expect(tmux.windowOf(a.paneId)).toBe("a");
    expect(tmux.windowOf(shellPane())).toBe(WORKSPACE_WINDOW);

    await workspace.open("a");
    expect(tmux.windowOf(shellPane())).toBe("shell");
    expect(tmux.windowOf(a.paneId)).toBe(WORKSPACE_WINDOW);

    await workspace.toggleShell();
    await workspace.close();
    expect(tmux.windowOf(shellPane())).toBe("shell");
    expect((await workspace.state()).shell).toEqual({ open: false });
  });

  test("is forgotten when the user exits it, and when the workspace stops", async () => {
    await workspace.up();
    await workspace.toggleShell();
    const first = shellPane();
    const pane = tmux.panes.get(first);
    if (pane) pane.dead = true;
    expect((await workspace.state()).shell).toBeNull();
    expect(tmux.panes.has(first)).toBe(false);

    await workspace.toggleShell();
    expect(shellPane()).not.toBe(first);
    await workspace.down();
    expect(shellPane()).toBe("");
  });
});

describe("wizard popups", () => {
  test("open over the workspace without holding up other requests", async () => {
    await workspace.up();
    workspace.popup("workflows");
    await workspace.state();
    expect(tmux.commands("display-popup")).toEqual([
      [
        "display-popup",
        "-E",
        "-w",
        "90%",
        "-h",
        "90%",
        "-T",
        " Workflows ",
        "DWA_PROJECT='/project' 'bun' '/dwa/cli.ts' wizard workflows",
      ],
    ]);
  });

  test("the tools dialog opens on the session it was asked for", async () => {
    await workspace.up();
    workspace.popup("tools", "id-3");
    workspace.popup("roles");
    await workspace.state();
    const [tools, roles] = tmux.commands("display-popup");
    expect(tools?.slice(-2)).toEqual([
      " Agent tools ",
      "DWA_PROJECT='/project' 'bun' '/dwa/cli.ts' wizard tools 'id-3'",
    ]);
    expect(roles?.at(-1)).toBe("DWA_PROJECT='/project' 'bun' '/dwa/cli.ts' wizard roles");
  });
});

describe("zoom and detach", () => {
  test("zoom gives main the window and detach lets the terminal go", async () => {
    const { main } = await workspace.up();
    await workspace.zoomMain();
    expect(tmux.commands("resize-pane").at(-1)).toEqual([
      "resize-pane",
      "-Z",
      "-t",
      main?.paneId ?? "",
    ]);
    await workspace.detach();
    expect(tmux.commands("detach-client")).toEqual([["detach-client", "-s", "dwa"]]);
    workspace.popup("questions");
    expect(tmux.commands("display-popup").at(-1)?.slice(1, 8)).toEqual([
      "-E",
      "-w",
      "80%",
      "-h",
      "60%",
      "-T",
      " Questions ",
    ]);
  });
});

describe("roles", () => {
  const session = (id: string) => ({
    settings: JSON.parse(files.get(`/project/.dwa/run/agents/${id}/settings.json`) ?? "{}"),
    mcp: JSON.parse(files.get(`/project/.dwa/run/agents/${id}/mcp.json`) ?? "{}").mcpServers,
    prompt: files.get(`/project/.dwa/run/agents/${id}/prompt.md`) ?? "",
  });
  const argvOf = (paneId: string) => tmux.panes.get(paneId)?.argv ?? [];

  beforeEach(() => {
    config.mcp = { github: { command: "gh-mcp", args: ["serve"], env: { TOKEN: "t" } } };
    config.plugins = { lint: { path: "/project/tools/lint" } };
    roles.explore = 'deny_tools = ["Edit", "Write"]\nprompt = "You explore."';
    roles.reviewer = `
extends = "explore"
permission_mode = "plan"
allow = ["Bash(git log *)"]
deny = ["Read(.env)"]
mcp = ["github"]
plugins = ["lint"]
skills = ["review", "house-style"]
`;
    disk = {
      "/project/.claude/skills/review/SKILL.md": "",
      "/project/.claude/skills/deploy/SKILL.md": "",
      "/project/.dwa/skills/house-style/SKILL.md": "",
      "/project/tools/lint/.mcp.json": JSON.stringify({
        mcpServers: { linter: { command: "$" + "{CLAUDE_PLUGIN_ROOT}/server" } },
      }),
      "/project/.mcp.json": JSON.stringify({ mcpServers: { db: { command: "db-mcp" } } }),
    };
    commands = ["gh-mcp"];
  });

  test("a session is started with what its role says and nothing of the user's own setup", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ name: "rev", role: "reviewer", task: "review it" });
    const dir = "/project/.dwa/run/agents/id-3";
    expect(argvOf(agent.paneId)).toEqual([
      "/bin/claude_me",
      "--setting-sources",
      "project,local",
      "--tools",
      "Read,Bash,Glob,Grep,Skill,AskUserQuestion,ExitPlanMode,WaitForMcpServers",
      "--session-id",
      "id-4",
      "--name",
      "rev",
      "--settings",
      `${dir}/settings.json`,
      "--strict-mcp-config",
      "--mcp-config",
      `${dir}/mcp.json`,
      "--append-system-prompt-file",
      `${dir}/prompt.md`,
      "--permission-mode",
      "plan",
      "--plugin-dir",
      "/project/tools/lint",
      "--plugin-dir",
      `${dir}/skills-plugin`,
    ]);

    const { settings, mcp, prompt } = session("id-3");
    expect(settings.permissions).toEqual({
      allow: ["mcp__dwa", "Bash(git log *)"],
      deny: ["Read(.env)"],
    });
    // The project skill the role does not list is switched off; the personal CLAUDE.md of the
    // profile's config directory (and of the default one) is not loaded.
    expect(settings.skillOverrides).toEqual({ ...builtinOff, deploy: "off" });
    expect(JSON.parse(files.get(`${dir}/skills.json`) ?? "")).toEqual([
      "review",
      "dwa:house-style",
      "lint:*",
    ]);
    expect(settings.claudeMdExcludes).toContain("/home/me/.claude-me/CLAUDE.md");
    expect(settings.claudeMdExcludes).toHaveLength(2);

    // The plugin's server, the project's, the role's and dwa's own.
    expect(Object.keys(mcp)).toEqual(["linter", "db", "github", "dwa"]);
    expect(mcp.linter.command).toBe("/project/tools/lint/server");
    expect(mcp.github).toEqual({
      type: "stdio",
      command: "gh-mcp",
      args: ["serve"],
      env: { TOKEN: "t" },
    });

    // The inherited prompt follows the workspace part.
    expect(prompt).toContain('You are "rev"');
    expect(prompt.endsWith("# Your role: reviewer\n\nYou explore.")).toBe(true);

    // The dwa skill reaches the session through a plugin made for it; the project skill needs none.
    expect(
      JSON.parse(files.get(`${dir}/skills-plugin/.claude-plugin/plugin.json`) ?? "{}").name,
    ).toBe("dwa");
    expect([...links]).toEqual([
      [`${dir}/skills-plugin/skills/house-style`, "/project/.dwa/skills/house-style"],
    ]);
  });

  test("a session without dwa skills gets no generated plugin, and every project skill", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ name: "ex", role: "explore" });
    expect(argvOf(agent.paneId)).not.toContain("--plugin-dir");
    // Only the skills built into the Claude command are off.
    expect(session("id-3").settings.skillOverrides).toEqual(builtinOff);
    expect(JSON.parse(files.get("/project/.dwa/run/agents/id-3/skills.json") ?? "")).toEqual([
      "deploy",
      "review",
    ]);
    expect(Object.keys(session("id-3").mcp)).toEqual(["db", "dwa"]);
    expect(links.size).toBe(0);
  });

  test("a skill that asks for a fork is off as a skill and started as an agent", async () => {
    const fork = "---\ndescription: Ships it\ncontext: fork\nagent: explore\n---\nShip.";
    disk["/project/.claude/skills/deploy/SKILL.md"] = fork;
    disk["/project/.dwa/skills/house-style/SKILL.md"] = fork;
    await workspace.up();
    // The role lists house-style: it is not handed over, and the prompt says how to run it.
    const rev = await workspace.spawn({ name: "rev", role: "reviewer" });
    expect(argvOf(rev.paneId)).not.toContain("/project/.dwa/run/agents/id-3/skills-plugin");
    expect(links.size).toBe(0);
    expect(session("id-3").prompt).toContain(
      "# Skills that run as their own agent\n\nThese skills ask for a separate agent",
    );
    expect(session("id-3").prompt.endsWith("- house-style: Ships it")).toBe(true);
    // Without a list of skills the project's forking skill is switched off by name.
    const ex = await workspace.spawn({ name: "ex", role: "explore" });
    expect(session("id-5").settings.skillOverrides).toEqual({ ...builtinOff, deploy: "off" });
    // The Skill tool may not be called with it either.
    expect(JSON.parse(files.get("/project/.dwa/run/agents/id-5/skills.json") ?? "")).toEqual([
      "review",
    ]);
    expect(session("id-5").prompt.endsWith("- deploy: Ships it")).toBe(true);

    // Started with the skill: its file is the task, its `agent` the role, its name the name.
    const run = await workspace.spawn({ skill: "deploy", task: "to staging", from: ex.id });
    expect(run).toMatchObject({ name: "deploy", role: "explore" });
    expect(run.task).toStartWith(
      'Your task is to run the skill "deploy". Read /project/.claude/skills/deploy/SKILL.md now',
    );
    expect(run.task).toContain('\n\nto staging\n\n---\n[dwa] "ex" started you for this task');
    // A role of the request wins over the skill's, and an unknown skill is refused.
    const other = await workspace.spawn({ skill: "house-style", role: "reviewer" });
    expect(other.role).toBe("reviewer");
    expect(workspace.spawn({ skill: "code-review" })).rejects.toThrow(
      /Unknown skill "code-review"/,
    );
    expect(workspace.spawn({ skill: "../x" })).rejects.toThrow(/Unknown skill/);
  });

  test("the main session runs as the main role", async () => {
    roles.main = 'tools = ["Read", "Bash"]\nprompt = "You lead."';
    const { main } = await workspace.up();
    expect(main?.role).toBe("main");
    expect(argvOf(main?.paneId ?? "").slice(3, 5)).toEqual([
      "--tools",
      "Read,Bash,WaitForMcpServers",
    ]);
    expect(session("id-1").prompt.endsWith("# Your role: main\n\nYou lead.")).toBe(true);
    expect(main?.capabilities?.tools).toEqual(["Read", "Bash"]);
  });

  test("what a session was started with is kept with the agent", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ name: "rev", role: "reviewer", model: "opus" });
    const expected = {
      model: "opus",
      permissionMode: "plan",
      tools: DEFAULT_TOOLS.filter((tool) => tool !== "Edit" && tool !== "Write"),
      denyTools: [],
      allow: ["Bash(git log *)"],
      deny: ["Read(.env)"],
      mcp: ["github"],
      plugins: ["lint"],
      skills: ["review", "house-style"],
      memory: false,
    };
    expect(agent.capabilities).toEqual(expected);
    expect((await workspace.state()).agents[0]?.capabilities).toEqual(expected);
    const stored = JSON.parse(store.getLaunch(agent.id) ?? "{}");
    expect(stored).toMatchObject({ role: "reviewer", model: "opus", hiddenSkills: ["deploy"] });
    expect(stored.mcp.github.command).toBe("gh-mcp");
  });

  test("the user's own spawn can change anything; an agent's can only take away", async () => {
    await workspace.up();
    const wide = await workspace.spawn({
      role: "explore",
      tools: ["Read", "Edit"],
      mcp: ["github"],
    });
    expect(wide.capabilities).toMatchObject({
      tools: ["Read", "Edit"],
      denyTools: [],
      mcp: ["github"],
    });

    const narrow = await workspace.spawn({
      role: "reviewer",
      narrowOnly: true,
      deny_tools: ["Bash"],
      mcp: [],
      skills: ["review"],
    });
    expect(narrow.capabilities).toMatchObject({
      tools: ["Read", "Glob", "Grep", "Skill", "AskUserQuestion", "ExitPlanMode"],
      mcp: [],
      skills: ["review"],
    });
    const refused = (request: object) =>
      expect(workspace.spawn({ role: "explore", narrowOnly: true, ...request })).rejects;
    await refused({ tools: ["Edit"] }).toThrow(
      /an agent can only narrow a role, so it cannot set tools/,
    );
    await refused({ mcp: ["github"] }).toThrow(/MCP server "github" is not part of it/);
    await refused({ permission_mode: "bypassPermissions" }).toThrow(/cannot set permission_mode/);
    await refused({ subagents: true }).toThrow(/cannot turn subagents on/);
    expect((await workspace.state()).agents).toHaveLength(2);
  });

  test("list_roles gives the roles as they are now, without the asking session's own", async () => {
    roles = { main: "in_role_list = false", explore: 'description = "Reads the code."' };
    await workspace.up();
    const explore = await workspace.spawn({ role: "explore" });
    expect(workspace.roleList("id-1")).toBe("- explore: Reads the code.");
    roles = { ...roles, helper: 'when_to_use = "Odd jobs."' };
    expect(workspace.roleList("id-1")).toBe("- explore: Reads the code.\n- helper: Odd jobs.");
    expect(workspace.roleList(explore.id)).toBe("- helper: Odd jobs.");
  });

  test("an agent that names a role that does not exist is pointed to list_roles", async () => {
    // In these tests every role has a file except "main", so a parent of that name is missing.
    roles = { odd: 'extends = "main"' };
    await workspace.up();
    await expect(workspace.spawn({ role: "odd", narrowOnly: true, from: "id-1" })).rejects.toThrow(
      /Unknown role "main".* Call list_roles to see the roles and what each is for\.$/,
    );
    const mine = await workspace.spawn({ role: "odd" }).catch((error: Error) => error.message);
    expect(mine).toContain('Unknown role "main"');
    expect(mine).not.toContain("list_roles");
  });

  test("a session that would miss something is not started", async () => {
    await workspace.up();
    commands = [];
    await expect(workspace.spawn({ name: "rev", role: "reviewer" })).rejects.toThrow(
      'Cannot start "rev": MCP server "github": command "gh-mcp" was not found.',
    );
    await expect(workspace.spawn({ role: "explore", mcp: ["slack"] })).rejects.toThrow(
      /unknown MCP server "slack"/,
    );
    await expect(workspace.spawn({ role: "explore", skills: ["nope"] })).rejects.toThrow(
      /unknown skill "nope"/,
    );
    await expect(workspace.spawn({ role: "explore", tools: "Read" as never })).rejects.toThrow(
      /Agent settings: tools/,
    );
    expect((await workspace.state()).agents).toEqual([]);
  });

  test("the workspace does not start when the main role is broken", async () => {
    config.main = { role: "lead" };
    roles.lead = 'mcp = ["nowhere"]';
    await expect(workspace.up()).rejects.toThrow(/Role "lead": unknown MCP server "nowhere"/);
    expect(tmux.commands("new-session")).toHaveLength(0);
  });
});

describe("model and effort", () => {
  /** The `--model` and `--effort` arguments of the agent started last. */
  function tuning(): string[] {
    const argv = [...tmux.panes.values()].at(-1)?.argv ?? [];
    const flag = (arg: string | undefined) => arg === "--model" || arg === "--effort";
    return argv.filter((arg, index) => flag(arg) || flag(argv[index - 1]));
  }

  test("nothing is passed when nothing is set", async () => {
    await workspace.up();
    await workspace.spawn({ name: "dev", role: "developer" });
    expect(tuning()).toEqual([]);
  });

  test("the agent's own setting wins, then the role file, then the defaults", async () => {
    config.defaults = { model: "sonnet", effort: "medium" };
    roles.reviewer = 'model = "opus"';
    await workspace.up();

    await workspace.spawn({ name: "plain" });
    expect(tuning()).toEqual(["--model", "sonnet", "--effort", "medium"]);

    // The role file sets a model, so the default model does not apply; effort still does.
    await workspace.spawn({ name: "rev", role: "reviewer" });
    expect(tuning()).toEqual(["--model", "opus", "--effort", "medium"]);

    await workspace.spawn({ name: "rev2", role: "reviewer", model: "haiku", effort: "low" });
    expect(tuning()).toEqual(["--model", "haiku", "--effort", "low"]);
  });

  test("agents from the config carry their settings, and the defaults reach main too", async () => {
    config.defaults = { model: "sonnet" };
    config.agents = [{ name: "rev", effort: "high" }];
    await workspace.up();
    expect(tuning()).toEqual(["--model", "sonnet", "--effort", "high"]);
    // Main is a session like the others: the defaults apply, its own effort is not set.
    const main = [...tmux.panes.values()].find((pane) => pane.argv.includes("main"));
    expect(main?.argv.slice(-2)).toEqual(["--model", "sonnet"]);
  });

  test("the main session takes its own section, after the profile's arguments", async () => {
    config.main = { model: "opus", effort: "medium" };
    config.default_profile = "work";
    await workspace.up();
    const main = [...tmux.panes.values()].find((pane) => pane.argv.includes("main"));
    const argv = main?.argv ?? [];
    expect(argv.slice(-4)).toEqual(["--model", "opus", "--effort", "medium"]);
    expect(argv.indexOf("--verbose")).toBeLessThan(argv.indexOf("--model"));
    // Agents do not inherit it.
    await workspace.spawn({ name: "dev" });
    expect(tuning()).toEqual([]);
  });

  test("an unknown effort level is refused", async () => {
    await workspace.up();
    await expect(workspace.spawn({ name: "dev", effort: "extreme" })).rejects.toThrow(
      /Invalid effort "extreme": use low, medium, high, xhigh, max/,
    );
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
    // The hook approves dwa's own tools in plan mode itself, so nobody is waited for.
    send("PermissionRequest", { tool_name: "mcp__dwa__spawn_agent", permission_mode: "plan" });
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
    const line = workspace.statusline({
      agentId: main?.id ?? "",
      data: {
        model: { id: "claude-fable-5-2", display_name: "Fable 5.2" },
        context_window: { used_percentage: 41, context_window_size: 1000000 },
        cost: { total_cost_usd: 0.7 },
        rate_limits: {
          five_hour: { used_percentage: 9, resets_at: 1795559400 },
          seven_day: { used_percentage: 12, resets_at: 1795766400 },
        },
      },
    });
    expect((await workspace.state()).main?.telemetry).toMatchObject({
      contextPercent: 41,
      contextSize: 1000000,
      costUsd: 0.7,
      model: "Fable 5.2",
      fiveHour: { usedPercent: 9, resetsAt: 1795559400 },
      sevenDay: { usedPercent: 12, resetsAt: 1795766400 },
    });
    // The session's own status line: the row is there anyway, so it says what is known.
    expect(line).toBe("Fable 5.2 · context 41%/1M · $0.70");
    expect(workspace.statusline({ agentId: "nobody", data: {} })).toBe("");
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
    // Each has had a prompt and is idle again: only then do messages go through the hook.
    for (const agentId of [main?.id ?? "", dev.id, rev.id]) {
      workspace.hook({ agentId, event: "UserPromptSubmit", input: {} });
      workspace.hook({ agentId, event: "Stop", input: {} });
    }
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

  test("a session that never had a prompt gets its first message pasted, not through the hook", async () => {
    await workspace.up();
    const fresh = await workspace.spawn({ name: "fresh" });
    const m = workspace.messaging;
    workspace.hook({ agentId: fresh.id, event: "SessionStart", input: {} });
    let handed: string[] | null = null;
    void m.waitMailbox(fresh.id).then((messages) => {
      handed = messages;
    });
    m.send("user", "fresh", "hello");
    await Bun.sleep(0);
    // The hook is waiting, and still the message stays for the paste.
    expect(handed).toBeNull();
    expect(store.pendingMessages(fresh.id)).toHaveLength(1);
    scheduled.at(-1)?.();
    await Bun.sleep(400);
    expect(tmux.commands("set-buffer").at(-1)?.at(-1)).toBe("[dwa] Message from the user:\nhello");
    expect(handed).toBeNull();

    // A message that was waiting when the hook connects is pasted too.
    const late = await workspace.spawn({ name: "late" });
    workspace.hook({ agentId: late.id, event: "SessionStart", input: {} });
    m.send("user", "late", "early bird");
    scheduled.length = 0;
    void m.waitMailbox(late.id);
    expect(store.pendingMessages(late.id)).toHaveLength(1);
    scheduled.at(-1)?.();
    await Bun.sleep(400);
    expect(tmux.commands("set-buffer").at(-1)?.at(-1)).toBe(
      "[dwa] Message from the user:\nearly bird",
    );
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
    // A message from an earlier run of the workspace is not shown again.
    store.addMessage({ fromId: "gone", toId: "user", body: "old news", createdAt: 1 });
    const { dev, m } = await team();
    m.send(dev, "user", "done with the fix");
    const state = await workspace.state();
    expect(state.inbox.map((entry) => [entry.from, entry.body])).toEqual([
      ["dev", "done with the fix"],
    ]);
    // Cleared messages are not shown again; later ones are, and nothing is deleted.
    workspace.clearInbox();
    expect((await workspace.state()).inbox).toEqual([]);
    m.send(dev, "user", "and the tests pass");
    expect((await workspace.state()).inbox.map((entry) => entry.body)).toEqual([
      "and the tests pass",
    ]);
    expect(store.recentMessages("user", 10).map((row) => row.body)).toContain("done with the fix");
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
      roleFiles: testRoleFiles(),
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
