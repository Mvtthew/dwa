import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { ConfigError, EMPTY_CONFIG, mergeConfig, parseConfig } from "../src/shared/config.ts";
import {
  findRole,
  listRoles,
  missingOnThisMachine,
  parseRole,
  type RoleContext,
  type RoleFiles,
  resolveSession,
} from "../src/shared/roles.ts";

const ROOT = "/p";
const ENV = { XDG_CONFIG_HOME: "/home/.config" };
const USER = "/home/.config/dwa";

/** A file system made of a path-to-text map; directories exist when something is inside them. */
function memoryFiles(entries: Record<string, string>, commands: string[] = []): RoleFiles {
  const paths = Object.keys(entries);
  return {
    read: (path) => entries[path] ?? null,
    exists: (path) => paths.some((known) => known === path || known.startsWith(`${path}/`)),
    list: (dir) => [
      ...new Set(
        paths
          .filter((known) => known.startsWith(`${dir}/`))
          .map((known) => known.slice(dir.length + 1).split("/")[0] as string),
      ),
    ],
    which: (command) => (commands.includes(command) ? `/bin/${command}` : null),
  };
}

function context(entries: Record<string, string>, commands: string[] = []): RoleContext {
  return { projectRoot: ROOT, env: ENV, files: memoryFiles(entries, commands) };
}

const CONFIG = parseConfig(
  `
[defaults]
model = "sonnet"
permission_mode = "manual"
deny_tools = ["WebFetch"]

[mcp.github]
command = "gh-mcp"
args = ["serve"]

[mcp.docs]
type = "http"
url = "https://example.test/mcp"

[plugins.lint]
path = "tools/lint"
`,
  "config.toml",
  ROOT,
);

const FILES = {
  [`${ROOT}/.dwa/roles/explore.toml`]: `
description = "Reads the code"
deny_tools = ["Edit", "Write"]
mcp = ["github"]
prompt = "You explore."
`,
  [`${ROOT}/.dwa/roles/reviewer.toml`]: `
extends = "explore"
model = "opus"
effort = "high"
mcp = ["github", "docs"]
plugins = ["lint"]
skills = ["review", "house-style"]
`,
  [`${ROOT}/.dwa/roles/tight.toml`]: `
tools = ["Read", "Grep", "Bash"]
allow = ["Bash(git log *)"]
`,
  [`${USER}/roles/personal.toml`]: `prompt = "Mine."`,
  [`${USER}/roles/explore.toml`]: `prompt = "Hidden by the project's explore."`,
  [`${ROOT}/.claude/skills/review/SKILL.md`]: "review",
  [`${ROOT}/.claude/skills/deploy/SKILL.md`]: "deploy",
  [`${ROOT}/.dwa/skills/house-style/SKILL.md`]: "style",
  [`${USER}/skills/notes/SKILL.md`]: "notes",
  [`${ROOT}/tools/lint/plugin.json`]: "{}",
};

describe("role files", () => {
  test("parses the settings and the prompt", () => {
    const role = parseRole(FILES[`${ROOT}/.dwa/roles/explore.toml`] as string, "explore.toml");
    expect(role).toEqual({
      description: "Reads the code",
      deny_tools: ["Edit", "Write"],
      mcp: ["github"],
      prompt: "You explore.",
    });
  });

  test("refuses unknown keys, both tool lists and bad values", () => {
    expect(() => parseRole("colour = 1", "r.toml")).toThrow(ConfigError);
    expect(() => parseRole('tools = ["Read"]\ndeny_tools = ["Edit"]', "r.toml")).toThrow(
      /r\.toml: deny_tools: set either tools or deny_tools/,
    );
    expect(() => parseRole('permission_mode = "yolo"', "r.toml")).toThrow(/permission_mode/);
    expect(() => parseRole('mcp = ["a/b"]', "r.toml")).toThrow(/mcp/);
    expect(() => parseRole("prompt = ", "r.toml")).toThrow(/invalid TOML/);
  });

  test("lists project and personal roles, the project's first", () => {
    expect(listRoles(context(FILES)).map((role) => [role.name, role.source])).toEqual([
      ["explore", "project"],
      ["personal", "user"],
      ["reviewer", "project"],
      ["tight", "project"],
    ]);
    expect(findRole("explore", context(FILES))?.role.prompt).toBe("You explore.");
    expect(findRole("personal", context(FILES))?.source).toBe("user");
    expect(findRole("nobody", context(FILES))).toBeNull();
    expect(findRole("../etc", context(FILES))).toBeNull();
  });
});

describe("resolveSession", () => {
  test("a session without a role gets the defaults", () => {
    expect(resolveSession({ config: CONFIG }, context(FILES))).toEqual({
      role: undefined,
      model: "sonnet",
      effort: undefined,
      permissionMode: "manual",
      tools: undefined,
      denyTools: ["WebFetch"],
      allow: [],
      deny: [],
      mcp: {},
      plugins: [],
      skills: undefined,
      hiddenSkills: [],
      offMcp: [],
      offPlugins: [],
      offSkills: [],
      memory: false,
      prompt: undefined,
    });
  });

  test("layers defaults, the parent and the role; a list replaces the one below", () => {
    const session = resolveSession({ config: CONFIG, role: "reviewer" }, context(FILES));
    expect(session.model).toBe("opus");
    expect(session.effort).toBe("high");
    expect(session.permissionMode).toBe("manual");
    // From the parent, which replaced the list in [defaults].
    expect(session.denyTools).toEqual(["Edit", "Write"]);
    expect(Object.keys(session.mcp)).toEqual(["github", "docs"]);
    expect(session.mcp.github).toEqual({ command: "gh-mcp", args: ["serve"], env: {} });
    expect(session.plugins).toEqual([{ name: "lint", path: `${ROOT}/tools/lint` }]);
    expect(session.prompt).toBe("You explore.");
  });

  test("finds listed skills and hides the project skills that are not listed", () => {
    const session = resolveSession({ config: CONFIG, role: "reviewer" }, context(FILES));
    expect(session.skills).toEqual([
      { name: "review", source: "project", path: `${ROOT}/.claude/skills/review` },
      { name: "house-style", source: "dwa", path: `${ROOT}/.dwa/skills/house-style` },
    ]);
    expect(session.hiddenSkills).toEqual(["deploy"]);
    const personal = resolveSession(
      { config: CONFIG, role: "explore", overrides: { skills: ["notes"] } },
      context(FILES),
    );
    expect(personal.skills).toEqual([
      { name: "notes", source: "user", path: `${USER}/skills/notes` },
    ]);
    expect(personal.hiddenSkills).toEqual(["deploy", "review"]);
  });

  test("an allow list of tools drops the deny list from below, and the other way round", () => {
    const tight = resolveSession({ config: CONFIG, role: "tight" }, context(FILES));
    expect(tight.tools).toEqual(["Read", "Grep", "Bash"]);
    expect(tight.denyTools).toEqual([]);
    expect(tight.allow).toEqual(["Bash(git log *)"]);
    const reopened = resolveSession(
      { config: CONFIG, role: "tight", overrides: { deny_tools: ["Bash"] } },
      context(FILES),
    );
    expect(reopened.tools).toBeUndefined();
    expect(reopened.denyTools).toEqual(["Bash"]);
  });

  test("the user's overrides replace anything", () => {
    const session = resolveSession(
      {
        config: CONFIG,
        role: "explore",
        overrides: { model: "haiku", mcp: ["docs"], permission_mode: "acceptEdits" },
      },
      context(FILES),
    );
    expect(session.model).toBe("haiku");
    expect(Object.keys(session.mcp)).toEqual(["docs"]);
    expect(session.permissionMode).toBe("acceptEdits");
  });

  test("the main session runs as the main role when there is one", () => {
    const withMain = {
      ...FILES,
      [`${ROOT}/.dwa/roles/main.toml`]: 'model = "opus"\nprompt = "Lead."',
    };
    expect(resolveSession({ config: CONFIG, main: true }, context(withMain))).toMatchObject({
      role: "main",
      model: "opus",
      prompt: "Lead.",
    });
    expect(resolveSession({ config: CONFIG, main: true }, context(FILES)).role).toBeUndefined();

    const named = mergeConfig(CONFIG, parseConfig('[main]\nrole = "tight"\nmodel = "fable"', "c"));
    expect(resolveSession({ config: named, main: true }, context(withMain))).toMatchObject({
      role: "tight",
      model: "fable",
    });
    const missing = mergeConfig(CONFIG, parseConfig('[main]\nrole = "lead"', "c"));
    expect(() => resolveSession({ config: missing, main: true }, context(FILES))).toThrow(
      /Unknown role "lead"/,
    );
  });

  test("names what does not exist", () => {
    const ctx = context({
      ...FILES,
      [`${ROOT}/.claude/agents/old.md`]: "---\nname: old\n---",
      [`${ROOT}/.dwa/roles/a.toml`]: 'extends = "b"',
      [`${ROOT}/.dwa/roles/b.toml`]: 'extends = "a"',
      [`${ROOT}/.dwa/roles/orphan.toml`]: 'extends = "gone"',
    });
    const resolve = (role: string, overrides = {}) =>
      resolveSession({ config: CONFIG, role, overrides }, ctx);
    expect(() => resolve("old")).toThrow(
      /Unknown role "old": there is no \/p\/\.dwa\/roles\/old\.toml\. \/p\/\.claude\/agents\/old\.md is no longer used as a role/,
    );
    expect(() => resolve("nobody")).toThrow(/Roles here: a, b, explore/);
    expect(() => resolve("a")).toThrow(/extends forms a loop \(a → b → a\)/);
    expect(() => resolve("orphan")).toThrow(/Unknown role "gone"/);
    expect(() => resolve("explore", { mcp: ["slack"] })).toThrow(
      /Role "explore": unknown MCP server "slack" \(in config\.toml: github, docs\)/,
    );
    expect(() => resolve("explore", { plugins: ["x"] })).toThrow(/unknown plugin "x"/);
    expect(() => resolve("explore", { skills: ["x"] })).toThrow(/unknown skill "x"/);
    expect(() => resolveSession({ config: EMPTY_CONFIG, overrides: { mcp: ["a"] } }, ctx)).toThrow(
      /Session without a role: unknown MCP server "a" \(in config\.toml: none defined\)/,
    );
  });
});

describe("a spawn made by an agent", () => {
  const narrowed = (role: string, overrides: object) =>
    resolveSession({ config: CONFIG, role, overrides, narrowOnly: true }, context(FILES));

  test("can take away tools, rules, servers, plugins and skills, and pick model and effort", () => {
    const session = narrowed("reviewer", {
      model: "haiku",
      effort: "low",
      deny_tools: ["Bash", "Edit"],
      deny: ["Read(.env)"],
      mcp: ["docs"],
      plugins: [],
      skills: ["review"],
    });
    expect(session.model).toBe("haiku");
    expect(session.effort).toBe("low");
    expect(session.denyTools).toEqual(["Edit", "Write", "Bash"]);
    expect(session.deny).toEqual(["Read(.env)"]);
    expect(Object.keys(session.mcp)).toEqual(["docs"]);
    expect(session.plugins).toEqual([]);
    expect(session.skills?.map((skill) => skill.name)).toEqual(["review"]);
    expect(session.hiddenSkills).toEqual(["deploy"]);
  });

  test("can switch more built-ins off and memory off, but not memory on", () => {
    const config = mergeConfig(
      CONFIG,
      parseConfig('[defaults]\noff_skills = ["dataviz"]\nmemory = true', "c"),
    );
    const resolve = (overrides: object, narrowOnly = true) =>
      resolveSession({ config, role: "explore", overrides, narrowOnly }, context(FILES));
    expect(resolve({})).toMatchObject({ offSkills: ["dataviz"], offPlugins: [], memory: true });
    expect(
      resolve({ off_skills: ["pdf"], off_plugins: ["easel@builtin"], memory: false }),
    ).toMatchObject({
      offSkills: ["dataviz", "pdf"],
      offPlugins: ["easel@builtin"],
      memory: false,
    });
    expect(() =>
      resolveSession(
        { config: CONFIG, role: "explore", overrides: { memory: true }, narrowOnly: true },
        context(FILES),
      ),
    ).toThrow(/cannot turn memory on/);
    // The user's own override replaces the list instead of adding to it.
    expect(resolve({ off_skills: [] }, false).offSkills).toEqual([]);
  });

  test("removes denied tools from an allow list", () => {
    const session = narrowed("tight", { deny_tools: ["Bash"] });
    expect(session.tools).toEqual(["Read", "Grep"]);
    expect(session.denyTools).toEqual([]);
  });

  test("cannot widen the role", () => {
    expect(() => narrowed("explore", { tools: ["Edit"] })).toThrow(/cannot set tools/);
    expect(() => narrowed("explore", { allow: ["Bash(*)"] })).toThrow(/cannot set allow/);
    expect(() => narrowed("explore", { permission_mode: "bypassPermissions" })).toThrow(
      /cannot set permission_mode/,
    );
    expect(() => narrowed("explore", { mcp: ["github", "docs"] })).toThrow(
      /Role "explore": an agent can only narrow a role, and MCP server "docs" is not part of it \(it has: github\)/,
    );
    expect(() => narrowed("explore", { plugins: ["lint"] })).toThrow(/plugin "lint" is not part/);
    // A role without a skills list has the project skills only.
    expect(narrowed("explore", { skills: ["deploy"] }).skills?.[0]?.source).toBe("project");
    expect(() => narrowed("explore", { skills: ["house-style"] })).toThrow(
      /skill "house-style" is not part of it \(it has: deploy, review\)/,
    );
    expect(() => narrowed("reviewer", { skills: ["deploy"] })).toThrow(
      /skill "deploy" is not part/,
    );
  });
});

describe("missingOnThisMachine", () => {
  const session = resolveSession({ config: CONFIG, role: "reviewer" }, context(FILES));

  test("is empty when commands and plugin directories are there", () => {
    expect(missingOnThisMachine(session, context(FILES, ["gh-mcp"]))).toEqual([]);
  });

  test("names a missing command and a missing plugin directory", () => {
    const { [`${ROOT}/tools/lint/plugin.json`]: _plugin, ...withoutPlugin } = FILES;
    expect(missingOnThisMachine(session, context(withoutPlugin))).toEqual([
      'MCP server "github": command "gh-mcp" was not found',
      `plugin "lint": ${ROOT}/tools/lint does not exist`,
    ]);
  });

  test("takes a command with a slash as a path in the project", () => {
    const config = parseConfig('[mcp.local]\ncommand = "tools/server"', "c", ROOT);
    const local = resolveSession({ config, overrides: { mcp: ["local"] } }, context(FILES));
    expect(missingOnThisMachine(local, context(FILES))).toHaveLength(1);
    expect(missingOnThisMachine(local, context({ [`${ROOT}/tools/server`]: "" }))).toEqual([]);
  });
});

describe("the catalogues in config.toml", () => {
  test("plugin paths are taken from the directory the file belongs to", () => {
    expect(CONFIG.plugins.lint?.path).toBe(`${ROOT}/tools/lint`);
    const user = parseConfig('[plugins.mine]\npath = "plugins/mine"', "user", dirname(`${USER}/x`));
    expect(user.plugins.mine?.path).toBe(`${USER}/plugins/mine`);
    expect(parseConfig('[plugins.abs]\npath = "/opt/p"', "c", ROOT).plugins.abs?.path).toBe(
      "/opt/p",
    );
  });

  test("the project's entry replaces a personal one of the same name", () => {
    const user = parseConfig('[mcp.github]\ncommand = "mine"\n[mcp.notes]\ncommand = "notes"', "u");
    const merged = mergeConfig(user, CONFIG);
    expect(Object.keys(merged.mcp).sort()).toEqual(["docs", "github", "notes"]);
    expect(merged.mcp.github).toMatchObject({ command: "gh-mcp" });
  });

  test("refuses the workspace's own server name, bad names and mixed server kinds", () => {
    expect(() => parseConfig('[mcp.dwa]\ncommand = "x"', "c")).toThrow(/workspace's own server/);
    expect(() => parseConfig('[mcp."a b"]\ncommand = "x"', "c")).toThrow(ConfigError);
    expect(() => parseConfig('[mcp.x]\ncommand = "x"\nurl = "http://x"', "c")).toThrow(ConfigError);
    expect(() => parseConfig('[mcp.x]\ntype = "http"', "c")).toThrow(ConfigError);
  });

  test("defaults and agents take the capability fields", () => {
    const config = parseConfig(
      '[defaults]\ntools = ["Read"]\n[[agents]]\nname = "a"\nrole = "explore"\nmcp = ["github"]',
      "c",
    );
    expect(config.defaults.tools).toEqual(["Read"]);
    expect(config.agents[0]?.mcp).toEqual(["github"]);
    expect(() => parseConfig('[defaults]\ntools = ["Read"]\ndeny_tools = ["Edit"]', "c")).toThrow(
      /defaults\.deny_tools: set either/,
    );
  });
});
