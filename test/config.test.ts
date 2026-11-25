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
import { cleanEnv } from "../src/shared/env.ts";
import type { ResolvedSession } from "../src/shared/roles.ts";
import { buildTmuxConf, tmuxQuote } from "../src/tmux/conf.ts";
import { parsePaneList } from "../src/tmux/layout.ts";

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
    memory: false,
    ...values,
  });

  test("puts profile arguments first, keeps the user's settings out and the task last", () => {
    const launch = buildClaudeLaunch({
      profile,
      sessionId: "sid",
      name: "dev",
      session: session(),
      settingsPath: "/run/settings.json",
      mcpConfigPath: "/run/mcp.json",
      systemPromptPath: "/run/prompt.md",
      task: "fix it",
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
      "fix it",
    ]);
  });

  test("puts model and effort after the profile's arguments", () => {
    const launch = buildClaudeLaunch({
      profile: { ...profile, args: ["--model", "sonnet"] },
      sessionId: "sid",
      name: "dev",
      session: session({ model: "opus", effort: "high" }),
      task: "fix it",
    });
    expect(launch.argv.slice(-5)).toEqual(["--model", "opus", "--effort", "high", "fix it"]);
  });

  test("passes what the role allows: tools, permission mode and plugins", () => {
    const argv = (values: Partial<ResolvedSession>, skillPluginPath?: string) =>
      buildClaudeLaunch({
        profile: { ...profile, args: [] },
        sessionId: "sid",
        name: "dev",
        session: session(values),
        skillPluginPath,
        task: "go",
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
      "go",
    ]);
    // A list of tools is followed by another option, never by the task, which it would swallow.
    const limited = argv({ tools: ["Read", "Grep"] });
    expect(limited.slice(3, 6)).toEqual(["--tools", "Read,Grep", "--session-id"]);
    // Skills need the Skill tool, so a role that lists skills keeps it.
    expect(argv({ tools: ["Read"], skills: [skill] })[4]).toBe("Read,Skill");
    expect(argv({ tools: ["Read", "Skill"], skills: [skill] })[4]).toBe("Read,Skill");
    expect(argv({ tools: [] })[4]).toBe("");

    const plugins = argv({ plugins: [{ name: "lint", path: "/p/tools/lint" }] }, "/run/skills");
    expect(plugins.slice(-5)).toEqual([
      "--plugin-dir",
      "/p/tools/lint",
      "--plugin-dir",
      "/run/skills",
      "go",
    ]);
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
    expect(sessionPrompt("dev", base)).toBe(workspacePrompt("dev"));
    const prompt = sessionPrompt("rev", { ...base, role: "reviewer", prompt: "\nYou review.\n" });
    expect(prompt.startsWith(workspacePrompt("rev"))).toBe(true);
    expect(prompt.endsWith("\n\n# Your role: reviewer\n\nYou review.")).toBe(true);
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
  });

  test("parsePaneList reads pane id, dead flag and window", () => {
    expect(parsePaneList("%0 0 workspace\n%3 1 my agent\n")).toEqual([
      { paneId: "%0", dead: false, inWorkspace: true },
      { paneId: "%3", dead: true, inWorkspace: false },
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
    expect(merged.defaults).toEqual({ model: "sonnet", effort: "low", deny_tools: ["WebFetch"] });
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
