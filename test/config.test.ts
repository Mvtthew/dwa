import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeLaunch,
  buildClaudeMcpConfig,
  buildClaudeSettings,
} from "../src/providers/claude/launch.ts";
import { sessionPrompt, workspacePrompt } from "../src/providers/claude/prompt.ts";
import { layerCapabilities } from "../src/shared/capabilities.ts";
import {
  allProfiles,
  ConfigError,
  EMPTY_CONFIG,
  loadConfig,
  mergeConfig,
  parseConfig,
  resolveProfile,
} from "../src/shared/config.ts";
import { cleanEnv, spawnOrigin } from "../src/shared/env.ts";
import { type ResolvedSession, resolveSession } from "../src/shared/roles.ts";
import { SHORTCUTS } from "../src/shared/shortcuts.ts";
import { buildTmuxConf, menuArgs, tmuxQuote } from "../src/tmux/conf.ts";
import { parsePaneList } from "../src/tmux/layout.ts";
import { testRoleFiles } from "./role-files.ts";

const TOML = `
default_profile = "me"

[profiles.me]
command = "~/claude_me"

[profiles.work]
command = "$TOOLS/claude_work"
args = ["--verbose"]
env = { TEAM = "x" }
`;

describe("parseConfig", () => {
  test("reads profiles with defaults", () => {
    const config = parseConfig(TOML, "test");
    expect(config.default_profile).toBe("me");
    expect(config.profiles.me).toEqual({ command: "~/claude_me", args: [], env: {} });
    expect(config.profiles.work?.args).toEqual(["--verbose"]);
  });

  test("an empty file is a valid config", () => {
    expect(parseConfig("", "test")).toEqual(EMPTY_CONFIG);
  });

  test("reports the file and field for a bad value", () => {
    expect(() => parseConfig("[profiles.me]\ncommand = 3", "cfg.toml")).toThrow(
      /cfg\.toml: profiles\.me\.command/,
    );
    expect(() => parseConfig("[profiles.me]\ncomand = 'x'", "cfg.toml")).toThrow(ConfigError);
    expect(() => parseConfig("not toml ===", "cfg.toml")).toThrow(/cfg\.toml: invalid TOML/);
  });
});

describe("agents and layout", () => {
  test("are read from the config and validated", () => {
    const config = parseConfig(
      `
[[agents]]
name = "rev"
role = "reviewer"
task = "review HEAD"

[layout]
agents_width = 40
`,
      "test",
    );
    expect(config.agents).toEqual([{ name: "rev", role: "reviewer", task: "review HEAD" }]);
    expect(config.layout).toEqual({ agents_width: 40 });
    expect(
      parseConfig("[layout]\nmain_min_width = 100\nagent_min_width = 80\nside_scale_max = 100", "c")
        .layout,
    ).toEqual({ main_min_width: 100, agent_min_width: 80, side_scale_max: 100 });
    expect(() => parseConfig("[layout]\nside_scale_max = 90", "cfg")).toThrow(/side_scale_max/);
    expect(() => parseConfig("[layout]\nagents_width = 4", "cfg")).toThrow(/layout\.agents_width/);
    expect(() => parseConfig("[[agents]]\nrole = 'x'", "cfg")).toThrow(/agents\.0\.name/);
  });

  test("the project's agent list replaces the personal one; layout merges", () => {
    const user = parseConfig("[[agents]]\nname = 'mine'\n[layout]\nstatus_width = 20", "user");
    const project = parseConfig("[[agents]]\nname = 'theirs'\n[layout]\nagents_width = 40", "p");
    expect(mergeConfig(user, project).agents.map((agent) => agent.name)).toEqual(["theirs"]);
    expect(mergeConfig(user, project).layout).toEqual({ status_width: 20, agents_width: 40 });
    expect(mergeConfig(user, parseConfig("", "p")).agents.map((agent) => agent.name)).toEqual([
      "mine",
    ]);
  });
});

describe("mergeConfig", () => {
  test("project settings override personal ones and profiles merge by name", () => {
    const user = parseConfig(TOML, "user");
    const project = parseConfig(
      'default_profile = "work"\n[profiles.me]\ncommand = "/opt/claude"',
      "project",
    );
    const merged = mergeConfig(user, project);
    expect(merged.default_profile).toBe("work");
    expect(merged.profiles.me?.command).toBe("/opt/claude");
    expect(merged.profiles.work?.command).toBe("$TOOLS/claude_work");
  });
});

describe("resolveProfile", () => {
  const config = parseConfig(TOML, "test");
  const env = { TOOLS: "/opt/tools" };

  test("follows the documented order", () => {
    const override = { ...env, DWA_CLAUDE_COMMAND: "/x/claude" };
    expect(
      resolveProfile(config, { agentProfile: "work", workspaceProfile: "me" }, override).name,
    ).toBe("work");
    expect(resolveProfile(config, { workspaceProfile: "work" }, override).name).toBe("work");
    expect(resolveProfile(config, {}, override)).toMatchObject({
      name: "env",
      command: "/x/claude",
    });
    expect(resolveProfile(config, {}, env).name).toBe("me");
    expect(resolveProfile(EMPTY_CONFIG, {}, env)).toMatchObject({
      name: "default",
      command: "claude",
    });
  });

  test("expands the command", () => {
    expect(resolveProfile(config, {}, env).command).toBe(join(homedir(), "claude_me"));
    expect(resolveProfile(config, { agentProfile: "work" }, env)).toMatchObject({
      command: "/opt/tools/claude_work",
      args: ["--verbose"],
      env: { TEAM: "x" },
    });
  });

  test("names the available profiles when one is unknown", () => {
    expect(() => resolveProfile(config, { agentProfile: "nope" }, env)).toThrow(
      'Unknown profile "nope" (available: me, work)',
    );
  });

  test("allProfiles lists every profile, or the fallback when none are defined", () => {
    expect(allProfiles(config, env).map((profile) => profile.name)).toEqual(["me", "work"]);
    expect(allProfiles(EMPTY_CONFIG, {}).map((profile) => profile.command)).toEqual(["claude"]);
  });
});

describe("buildClaudeLaunch", () => {
  const profile = { name: "work", command: "/bin/cw", args: ["--verbose"], env: { TEAM: "x" } };
  const session = (values: Partial<ResolvedSession> = {}): ResolvedSession => ({
    denyTools: [],
    allow: [],
    deny: [],
    mcp: {},
    plugins: [],
    hiddenSkills: [],
    offMcp: [],
    offPlugins: [],
    offSkills: [],
    allowedSkills: [],
    memory: false,
    ...values,
  });

  test("puts profile arguments first, keeps the user's settings out and gives no first prompt", () => {
    const launch = buildClaudeLaunch({
      profile,
      sessionId: "sid",
      name: "dev",
      session: session(),
      settingsPath: "/run/settings.json",
      mcpConfigPath: "/run/mcp.json",
      systemPromptPath: "/run/prompt.md",
    });
    expect(launch.argv).toEqual([
      "/bin/cw",
      "--verbose",
      "--setting-sources",
      "project,local",
      "--session-id",
      "sid",
      "--name",
      "dev",
      "--settings",
      "/run/settings.json",
      "--strict-mcp-config",
      "--mcp-config",
      "/run/mcp.json",
      "--append-system-prompt-file",
      "/run/prompt.md",
    ]);
  });

  test("puts model and effort after the profile's arguments", () => {
    const launch = buildClaudeLaunch({
      profile: { ...profile, args: ["--model", "sonnet"] },
      sessionId: "sid",
      name: "dev",
      session: session({ model: "opus", effort: "high" }),
    });
    expect(launch.argv.slice(-4)).toEqual(["--model", "opus", "--effort", "high"]);
  });

  test("passes what the role allows: tools, permission mode and plugins", () => {
    const argv = (values: Partial<ResolvedSession>, skillPluginPath?: string) =>
      buildClaudeLaunch({
        profile: { ...profile, args: [] },
        sessionId: "sid",
        name: "dev",
        session: session(values),
        skillPluginPath,
      }).argv;
    const skill = { name: "style", source: "dwa" as const, path: "/p/.dwa/skills/style" };

    expect(argv({ denyTools: ["Edit", "Write"], permissionMode: "plan" })).toEqual([
      "/bin/cw",
      "--setting-sources",
      "project,local",
      "--disallowedTools",
      "Edit,Write",
      "--session-id",
      "sid",
      "--name",
      "dev",
      "--permission-mode",
      "plan",
    ]);
    // A list of tools is followed by another option, which ends the list.
    const limited = argv({ tools: ["Read", "Grep"] });
    expect(limited.slice(3, 6)).toEqual(["--tools", "Read,Grep,WaitForMcpServers", "--session-id"]);
    // Skills need the Skill tool, so a role that lists skills keeps it.
    expect(argv({ tools: ["Read"], skills: [skill] })[4]).toBe("Read,Skill,WaitForMcpServers");
    expect(argv({ tools: ["Read", "Skill"], skills: [skill] })[4]).toBe(
      "Read,Skill,WaitForMcpServers",
    );
    expect(argv({ tools: [] })[4]).toBe("WaitForMcpServers");

    const plugins = argv({ plugins: [{ name: "lint", path: "/p/tools/lint" }] }, "/run/skills");
    expect(plugins.slice(-4)).toEqual([
      "--plugin-dir",
      "/p/tools/lint",
      "--plugin-dir",
      "/run/skills",
    ]);
  });

  test("a session resolved from the defaults is started without the subagent tools", () => {
    const ctx = { projectRoot: "/p", env: {}, files: testRoleFiles({}) };
    const argv = (toml: string) =>
      buildClaudeLaunch({
        profile,
        sessionId: "sid",
        name: "dev",
        session: resolveSession({ config: parseConfig(toml, "config.toml") }, ctx),
      }).argv;
    const value = (list: string[], flag: string) => list[list.indexOf(flag) + 1];

    // The default list has neither, so nothing needs taking away.
    const plain = argv("");
    expect(value(plain, "--tools")).toBe(
      "Read,Edit,Write,Bash,Glob,Grep,Skill,AskUserQuestion,ExitPlanMode,WaitForMcpServers",
    );
    expect(plain).not.toContain("--disallowedTools");
    expect(value(argv('[defaults]\ndeny_tools = ["Edit", "Skill"]'), "--tools")).toBe(
      "Read,Write,Bash,Glob,Grep,AskUserQuestion,ExitPlanMode,WaitForMcpServers",
    );
    // "Every tool" is the one case without a list: there they are taken away by name.
    const all = argv('[defaults]\ntools = ["*"]');
    expect(all).not.toContain("--tools");
    expect(value(all, "--disallowedTools")).toBe("Agent,Workflow");
    // An allow list simply does not name them.
    const only = argv('[defaults]\ntools = ["Read", "Agent"]');
    expect(value(only, "--tools")).toBe("Read,WaitForMcpServers");
    expect(only).not.toContain("--disallowedTools");
    // With subagents the default list has them.
    expect(value(argv("[defaults]\nsubagents = true"), "--tools")).toBe(
      "Read,Edit,Write,Bash,Glob,Grep,Skill,AskUserQuestion,ExitPlanMode,Agent,Workflow,WaitForMcpServers",
    );
    expect(argv('[defaults]\nsubagents = true\ntools = ["*"]')).not.toContain("--disallowedTools");
    expect(value(argv('[defaults]\nsubagents = true\ntools = ["Read", "Agent"]'), "--tools")).toBe(
      "Read,Agent,WaitForMcpServers",
    );
  });

  test("disables tool call timeouts and lets the profile override the environment", () => {
    const launch = buildClaudeLaunch({
      profile: { ...profile, env: { MCP_TOOL_TIMEOUT: "5" } },
      sessionId: "sid",
      name: "dev",
      session: session(),
    });
    expect(launch.env).toEqual({
      CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0",
      CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0",
      MCP_TOOL_TIMEOUT: "5",
    });
  });
});

describe("generated session files", () => {
  const commands = { hook: "dwa hook", statusline: "dwa statusline", mailbox: "dwa mailbox" };
  const base: ResolvedSession = {
    denyTools: [],
    allow: [],
    deny: [],
    mcp: {},
    plugins: [],
    hiddenSkills: [],
    offMcp: [],
    offPlugins: [],
    offSkills: [],
    allowedSkills: [],
    memory: false,
  };

  test("settings carry the role's rules and what the flags cannot keep out", () => {
    const plain = buildClaudeSettings(commands, base, { personalMemory: [] });
    expect(plain.permissions).toEqual({ allow: ["mcp__dwa"] });
    expect(plain).not.toHaveProperty("claudeMdExcludes");
    expect(plain).not.toHaveProperty("skillOverrides");

    const settings = buildClaudeSettings(
      commands,
      { ...base, allow: ["Bash(git log *)"], deny: ["Read(.env)"], hiddenSkills: ["deploy"] },
      { personalMemory: ["/home/.claude/CLAUDE.md"] },
    );
    expect(settings.permissions).toEqual({
      allow: ["mcp__dwa", "Bash(git log *)"],
      deny: ["Read(.env)"],
    });
    expect(settings).toMatchObject({
      claudeMdExcludes: ["/home/.claude/CLAUDE.md"],
      skillOverrides: { deploy: "off" },
    });
  });

  test("built-in plugins and skills are switched off by id, and memory is off unless asked for", () => {
    const off = buildClaudeSettings(
      commands,
      { ...base, hiddenSkills: ["deploy"], offSkills: ["dataviz"], offPlugins: ["easel@builtin"] },
      { personalMemory: [] },
    );
    expect(off).toMatchObject({
      skillOverrides: { deploy: "off", dataviz: "off" },
      enabledPlugins: { "easel@builtin": false },
      autoMemoryEnabled: false,
    });
    const on = buildClaudeSettings(commands, { ...base, memory: true }, { personalMemory: [] });
    expect(on).not.toHaveProperty("autoMemoryEnabled");
    expect(on).not.toHaveProperty("enabledPlugins");
  });

  test("the MCP config has the project's servers, the role's, and always dwa's own", () => {
    const own = { command: "bun", args: ["cli.ts", "mcp"], env: { DWA_AGENT_ID: "a" } };
    const config = buildClaudeMcpConfig(
      own,
      {
        ...base,
        mcp: {
          github: { command: "gh-mcp", args: ["serve"], env: {} },
          docs: { type: "http", url: "https://example.test/mcp", headers: {} },
        },
      },
      { github: { command: "from-project" }, db: { command: "db-mcp" }, dwa: { command: "fake" } },
    );
    expect(config.mcpServers as Record<string, unknown>).toEqual({
      github: { type: "stdio", command: "gh-mcp", args: ["serve"], env: {} },
      db: { command: "db-mcp" },
      docs: { type: "http", url: "https://example.test/mcp", headers: {} },
      dwa: { type: "stdio", ...own },
    });
  });

  test("the role's instructions follow the workspace part of the prompt", () => {
    // `base` denies nothing, so it has the built-in subagents.
    expect(sessionPrompt("dev", base)).toBe(workspacePrompt("dev", true));
    const prompt = sessionPrompt("rev", { ...base, role: "reviewer", prompt: "\nYou review.\n" });
    expect(prompt.startsWith(workspacePrompt("rev", true))).toBe(true);
    expect(prompt.endsWith("\n\n# Your role: reviewer\n\nYou review.")).toBe(true);
    const without = { ...base, denyTools: ["Agent", "Workflow"] };
    expect(sessionPrompt("dev", without)).toBe(workspacePrompt("dev"));
    expect(sessionPrompt("rev", { ...without, role: "reviewer", prompt: "You review." })).toBe(
      `${workspacePrompt("rev")}\n\n# Your role: reviewer\n\nYou review.`,
    );
  });

  test("the prompt says the built-in subagents are gone only when the session lacks Agent", () => {
    const paragraph = "The built-in Agent tool and its subagents";
    expect(workspacePrompt("dev")).toContain(paragraph);
    expect(workspacePrompt("dev", false)).toContain(paragraph);
    expect(workspacePrompt("dev", true)).not.toContain(paragraph);
    // Apart from that paragraph the two are the same text.
    const [before, after] = workspacePrompt("dev").split(paragraph) as [string, string];
    expect(workspacePrompt("dev", true).startsWith(before.trimEnd())).toBe(true);
    expect(workspacePrompt("dev", true).endsWith(after.slice(after.indexOf("\n\n")))).toBe(true);

    // Denied, or left out of an allow list: the paragraph is there.
    expect(sessionPrompt("dev", { ...base, denyTools: ["Agent", "Workflow"] })).toContain(
      paragraph,
    );
    expect(sessionPrompt("dev", { ...base, denyTools: ["Edit", "Agent"] })).toContain(paragraph);
    expect(sessionPrompt("dev", { ...base, tools: ["Read", "Bash"] })).toContain(paragraph);
    expect(sessionPrompt("dev", { ...base, tools: [] })).toContain(paragraph);
    // The session has Agent: nothing is said about it.
    expect(sessionPrompt("dev", base)).not.toContain(paragraph);
    expect(sessionPrompt("dev", { ...base, denyTools: ["Edit", "Workflow"] })).not.toContain(
      paragraph,
    );
    expect(sessionPrompt("dev", { ...base, tools: ["Read", "Agent"] })).not.toContain(paragraph);
    // An allow list decides alone, as it does for the launch.
    expect(sessionPrompt("dev", { ...base, tools: ["Read"], denyTools: [] })).toContain(paragraph);
  });

  test("a session resolved from the defaults is told so, one with subagents is not", () => {
    const paragraph = "The built-in Agent tool and its subagents";
    const ctx = { projectRoot: "/p", env: {}, files: testRoleFiles({}) };
    const prompt = (toml: string) =>
      sessionPrompt("dev", resolveSession({ config: parseConfig(toml, "config.toml") }, ctx));
    expect(prompt("")).toContain(paragraph);
    expect(prompt('[defaults]\ntools = ["Read", "Agent"]')).toContain(paragraph);
    expect(prompt("[defaults]\nsubagents = true")).not.toContain(paragraph);
    expect(prompt('[defaults]\nsubagents = true\ntools = ["Read"]')).toContain(paragraph);
  });
});

describe("spawnOrigin", () => {
  test("a spawn from inside a session is the session's own, and may only narrow", () => {
    expect(spawnOrigin({ DWA_AGENT_ID: "a1", DWA_PROJECT: "/p" })).toEqual({
      from: "a1",
      narrowOnly: true,
    });
    // The user's terminal, the shell pane and the popups.
    expect(spawnOrigin({ DWA_PROJECT: "/p" })).toEqual({});
    expect(spawnOrigin({ DWA_AGENT_ID: "" })).toEqual({});
  });
});

describe("cleanEnv", () => {
  test("drops variables of a parent Claude Code or tmux session and keeps user settings", () => {
    const cleaned = cleanEnv({
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "/home/u/.claude-work",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_MESSAGING_TOKEN: "secret",
      TMUX: "/tmp/tmux-1/default,1,0",
      UNSET: undefined,
    });
    expect(cleaned).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/home/u/.claude-work" });
  });
});

describe("tmux helpers", () => {
  test("tmuxQuote survives single quotes", () => {
    expect(tmuxQuote("it's")).toBe("'it'\\''s'");
  });

  test("the generated config binds keys to this project's CLI", () => {
    const conf = buildTmuxConf({ selfArgv: ["/bin/bun", "/dwa/cli.ts"], projectRoot: "/my proj" });
    // Popups have a background of their own, from the terminal's palette, with a text colour
    // that reads on it whatever the theme.
    expect(conf).toContain("set -g popup-style 'bg=black,fg=white'");
    expect(conf).toContain("set -g popup-border-style 'bg=black,fg=white'");
    expect(conf).toContain("set -g extended-keys always");
    expect(conf).toContain("bind -n M-9 run-shell -b ");
    expect(conf).toContain("set -g prefix C-q");
    expect(conf).toContain("bind 9 run-shell -b ");
    expect(buildTmuxConf({ selfArgv: ["bun"], projectRoot: "/p", prefix: "C-a" })).toContain(
      "bind C-a send-prefix",
    );
    expect(conf).toContain(`${tmuxQuote("/dwa/cli.ts").replaceAll("'", "'\\''")} key open 3'`);
    expect(conf).toContain("/my proj");
    expect(conf).toContain("bind s run-shell -b ");
    expect(conf).toContain(
      "bind w display-popup -E -w 90% -h 90% -T ' Workflows ' 'DWA_PROJECT='\\''/my proj'\\'' '\\''/bin/bun'\\'' '\\''/dwa/cli.ts'\\'' wizard workflows'",
    );
    expect(conf).toContain("bind -n M-a display-popup -E -w 70% -h 80% -T ' New agent ' ");
    expect(conf).toContain("bind t display-popup -E -w 70% -h 90% -T ' Agent tools ' ");
    expect(conf).toContain("bind -n M-r display-popup -E -w 70% -h 90% -T ' Role settings ' ");
    // Zoom goes through dwa, which applies a layout that waited for the zoom to end.
    expect(conf).toContain("bind z run-shell -b 'DWA_PROJECT=");
    expect(conf).toContain(" key zoom'");
    // Detach is after the prefix only: Alt+D deletes a word in the programs in the panes.
    expect(conf).toContain("bind d detach-client");
    expect(conf).not.toContain("M-d");
    // Every shortcut is bound after the prefix, the same keys as the menus list.
    for (const entry of SHORTCUTS) expect(conf).toContain(`bind ${entry.key} `);
  });

  test("a category's menu lists its shortcuts with their keys, under the given row", () => {
    const args = menuArgs("dwa", "Agents", 12, 2);
    expect(args.slice(0, 8)).toEqual([
      "display-menu",
      "-M",
      "-x",
      "12",
      "-y",
      "10",
      "-T",
      " Agents ",
    ]);
    // Four items and the hint, two border lines: the menu's last row is 2 + 7.
    expect(args.slice(8, 11)).toEqual(["New agent", "a", expect.stringContaining("New agent")]);
    expect(args.slice(-3)).toEqual(["-Open agent  1-9", "", ""]);
    expect(menuArgs("dwa", "Panes", 0, 2)).toContain("run-shell -b 'dwa key shell'");
  });

  test("parsePaneList reads pane id, dead flag, focus and window", () => {
    expect(parsePaneList("%0 0 1 workspace\n%3 1 0 my agent\n")).toEqual([
      { paneId: "%0", dead: false, active: true, inWorkspace: true },
      { paneId: "%3", dead: true, active: false, inWorkspace: false },
    ]);
  });
});

describe("pickAnswer", () => {
  test("a number picks the suggested answer, anything else is the answer itself", async () => {
    const { pickAnswer } = await import("../src/cli/talk.ts");
    expect(pickAnswer(" 2 ", ["yes", "no"])).toBe("no");
    expect(pickAnswer("3", ["yes", "no"])).toBe("3");
    expect(pickAnswer("7", [])).toBe("7");
    expect(pickAnswer("  use postgres ", ["yes"])).toBe("use postgres");
    expect(pickAnswer("", ["yes"])).toBe("");
  });
});

describe("inboxText", () => {
  test("lists open questions before messages, the user's own first", async () => {
    const { inboxText } = await import("../src/cli/talk.ts");
    const now = 10 * 60000;
    const question = {
      fromId: "a",
      toId: "user",
      question: "which color?",
      options: ["red", "blue"],
      createdAt: now - 5 * 60000,
    };
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips the colour codes
    const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[\d+m/g, "");
    const text = plain(
      inboxText(
        {
          projectRoot: "/p",
          keyPrefix: "C-q",
          up: true,
          main: null,
          agents: [],
          questions: [
            { ...question, id: 1, from: "bob", to: "alice", toId: "b" },
            { ...question, id: 2, from: "alice", to: "user" },
          ],
          inbox: [{ id: 1, from: "alice", body: "done", createdAt: now }],
          workflows: [],
          shell: null,
          feed: null,
        },
        now,
      ),
    );
    expect(text.indexOf("#2  alice asks you")).toBeGreaterThan(-1);
    expect(text.indexOf("#2  alice asks you")).toBeLessThan(text.indexOf("#1  bob asks alice"));
    expect(text).toContain("5 min ago");
    expect(text).toContain("Suggested: red | blue");
    expect(text.indexOf("MESSAGES")).toBeGreaterThan(text.indexOf("#1  bob asks alice"));
    expect(text).toContain("alice  just now\ndone");

    const empty = plain(
      inboxText(
        {
          projectRoot: "/p",
          keyPrefix: "C-q",
          up: true,
          main: null,
          agents: [],
          questions: [],
          inbox: [],
          workflows: [],
          shell: null,
          feed: null,
        },
        now,
      ),
    );
    expect(empty).not.toContain("OPEN QUESTIONS");
    expect(empty).toContain("No messages.");
  });
});

describe("model and effort settings", () => {
  test("defaults and agents accept them, and the project overrides field by field", () => {
    const user = parseConfig('[defaults]\nmodel = "sonnet"\neffort = "low"', "user");
    const project = parseConfig(
      '[defaults]\neffort = "high"\n[[agents]]\nname = "rev"\nmodel = "opus"\neffort = "max"',
      "project",
    );
    expect(mergeConfig(user, project).defaults).toEqual({ model: "sonnet", effort: "high" });
    expect(project.agents).toEqual([{ name: "rev", model: "opus", effort: "max" }]);
    expect(() => parseConfig('[defaults]\neffort = "extreme"', "cfg")).toThrow(/defaults\.effort/);

    const mainUser = parseConfig('[main]\nmodel = "opus"\neffort = "medium"', "user");
    const mainProject = parseConfig('[main]\neffort = "high"', "project");
    expect(mergeConfig(mainUser, mainProject).main).toEqual({ model: "opus", effort: "high" });
    expect(() => parseConfig('[main]\nprofile = "x"', "cfg")).toThrow(/main/);
  });
});

describe("personal defaults", () => {
  const USER = '[defaults]\nmodel = "haiku"\neffort = "low"\ntools = ["Read"]\n';
  const PROJECT = '[defaults]\nmodel = "sonnet"\ndeny_tools = ["WebFetch"]\n';

  test("the merged defaults are what they were, and the personal ones are also kept apart", () => {
    const user = parseConfig(USER, "user");
    const project = parseConfig(PROJECT, "project");
    const merged = mergeConfig(user, project);
    expect(merged.defaults).toEqual(layerCapabilities(user.defaults, project.defaults));
    expect(merged.defaults).toEqual({
      model: "sonnet",
      effort: "low",
      tools: ["Read"],
      deny_tools: ["WebFetch"],
    });
    expect(merged.userDefaults).toEqual({ model: "haiku", effort: "low", tools: ["Read"] });
    expect(mergeConfig(EMPTY_CONFIG, project).userDefaults).toEqual({});
    // One file's own text never says which place it is.
    expect(project.userDefaults).toBeUndefined();
  });

  test("loadConfig reads both files from their places", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dwa-config-"));
    try {
      // A personal folder of its own: the real one is never read.
      const env = { XDG_CONFIG_HOME: join(dir, "home") };
      mkdirSync(join(dir, "home", "dwa"), { recursive: true });
      mkdirSync(join(dir, ".dwa"));
      writeFileSync(join(dir, ".dwa", "config.toml"), PROJECT);
      expect((await loadConfig(dir, env)).userDefaults).toEqual({});
      writeFileSync(join(dir, "home", "dwa", "config.toml"), USER);
      const config = await loadConfig(dir, env);
      expect(config.userDefaults).toEqual({ model: "haiku", effort: "low", tools: ["Read"] });
      expect(config.defaults).toEqual({
        model: "sonnet",
        effort: "low",
        tools: ["Read"],
        deny_tools: ["WebFetch"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("answerQueue", () => {
  const question = (id: number, to: string) => ({
    id,
    from: "dev",
    to,
    fromId: "id-dev",
    toId: to,
    question: "?",
    options: [],
    createdAt: 0,
  });
  const open = [question(1, "rev"), question(2, "user"), question(3, "user")];

  test("the user's questions come first, and one id gives that question alone", async () => {
    const { answerQueue } = await import("../src/cli/talk.ts");
    expect(answerQueue(open).map((entry) => entry.id)).toEqual([2, 3, 1]);
    expect(answerQueue(open, 1).map((entry) => entry.id)).toEqual([1]);
    expect(answerQueue(open, 9)).toEqual([]);
  });
});
