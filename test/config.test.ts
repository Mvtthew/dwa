import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildClaudeLaunch } from "../src/providers/claude/launch.ts";
import {
  allProfiles,
  ConfigError,
  mergeConfig,
  parseConfig,
  resolveProfile,
} from "../src/shared/config.ts";
import { cleanEnv } from "../src/shared/env.ts";
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
    expect(parseConfig("", "test")).toEqual({ profiles: {} });
  });

  test("reports the file and field for a bad value", () => {
    expect(() => parseConfig("[profiles.me]\ncommand = 3", "cfg.toml")).toThrow(
      /cfg\.toml: profiles\.me\.command/,
    );
    expect(() => parseConfig("[profiles.me]\ncomand = 'x'", "cfg.toml")).toThrow(ConfigError);
    expect(() => parseConfig("not toml ===", "cfg.toml")).toThrow(/cfg\.toml: invalid TOML/);
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
    expect(resolveProfile({ profiles: {} }, {}, env)).toMatchObject({
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
    expect(allProfiles({ profiles: {} }, {}).map((profile) => profile.command)).toEqual(["claude"]);
  });
});

describe("buildClaudeLaunch", () => {
  const profile = { name: "work", command: "/bin/cw", args: ["--verbose"], env: { TEAM: "x" } };

  test("puts profile arguments first and the task last", () => {
    const launch = buildClaudeLaunch({
      profile,
      sessionId: "sid",
      name: "dev",
      role: "developer",
      task: "fix it",
    });
    expect(launch.argv).toEqual([
      "/bin/cw",
      "--verbose",
      "--session-id",
      "sid",
      "--name",
      "dev",
      "--agent",
      "developer",
      "fix it",
    ]);
  });

  test("disables tool call timeouts and lets the profile override the environment", () => {
    const launch = buildClaudeLaunch({
      profile: { ...profile, env: { MCP_TOOL_TIMEOUT: "5" } },
      sessionId: "sid",
      name: "dev",
    });
    expect(launch.env).toEqual({
      CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0",
      CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0",
      MCP_TOOL_TIMEOUT: "5",
    });
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
    expect(conf).toContain("set -g extended-keys always");
    expect(conf).toContain("bind -n M-9 run-shell -b ");
    expect(conf).toContain(`${tmuxQuote("/dwa/cli.ts").replaceAll("'", "'\\''")} agent open 3'`);
    expect(conf).toContain("/my proj");
  });

  test("parsePaneList reads pane id, dead flag and window", () => {
    expect(parsePaneList("%0 0 workspace\n%3 1 my agent\n")).toEqual([
      { paneId: "%0", dead: false, inWorkspace: true },
      { paneId: "%3", dead: true, inWorkspace: false },
    ]);
  });
});
