import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import {
  BUILTIN_SKILLS,
  DEFAULT_TOOLS,
  layerCapabilities,
  SUBAGENT_SKILLS,
  SUBAGENT_TOOLS,
} from "../src/shared/capabilities.ts";
import { ConfigError, EMPTY_CONFIG, mergeConfig, parseConfig } from "../src/shared/config.ts";
import {
  findRole,
  listAllRoles,
  listRoles,
  missingOnThisMachine,
  PERSONAL_DEFAULTS,
  parseRole,
  type RoleContext,
  type RoleFiles,
  resolveLayers,
  resolveSession,
  scopeNotes,
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

/** The default list of tools without those named. */
const base = (...gone: string[]) => DEFAULT_TOOLS.filter((tool) => !gone.includes(tool));
/** Every built-in skill but those named: what is switched off. */
const builtinOff = (...kept: string[]) => BUILTIN_SKILLS.filter((name) => !kept.includes(name));

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
      // The default list; a name taken away that is in no list is passed on as it is.
      tools: base(),
      denyTools: ["WebFetch"],
      allow: [],
      deny: [],
      mcp: {},
      plugins: [],
      skills: undefined,
      hiddenSkills: [],
      offMcp: [],
      offPlugins: [],
      offSkills: builtinOff(),
      allowedSkills: ["deploy", "review"],
      memory: false,
      prompt: undefined,
    });
  });

  test("layers defaults, the parent and the role; a list replaces the one below", () => {
    const session = resolveSession({ config: CONFIG, role: "reviewer" }, context(FILES));
    expect(session.model).toBe("opus");
    expect(session.effort).toBe("high");
    expect(session.permissionMode).toBe("manual");
    // From the parent, which replaced the list in [defaults]: taken out of the default tools.
    expect(session.tools).toEqual(base("Edit", "Write"));
    expect(session.denyTools).toEqual([]);
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

  test("a list of tools drops what was taken away below it; taking away keeps the list", () => {
    const tight = resolveSession({ config: CONFIG, role: "tight" }, context(FILES));
    expect(tight.tools).toEqual(["Read", "Grep", "Bash"]);
    expect(tight.denyTools).toEqual([]);
    expect(tight.allow).toEqual(["Bash(git log *)"]);
    const reopened = resolveSession(
      { config: CONFIG, role: "tight", overrides: { deny_tools: ["Bash"] } },
      context(FILES),
    );
    expect(reopened.tools).toEqual(["Read", "Grep"]);
    expect(reopened.denyTools).toEqual([]);
    // The list of a lower layer stays under a role that only takes away.
    const files = { ...FILES, [`${ROOT}/.dwa/roles/less.toml`]: 'deny_tools = ["Bash"]' };
    const listed = mergeConfig(CONFIG, parseConfig('[defaults]\ntools = ["Read", "Bash"]', "c"));
    expect(resolveSession({ config: listed, role: "less" }, context(files)).tools).toEqual([
      "Read",
    ]);
  });

  test("without a list a session has the default tools; * stands for every tool", () => {
    expect(DEFAULT_TOOLS).toEqual([
      "Read",
      "Edit",
      "Write",
      "Bash",
      "Glob",
      "Grep",
      "Skill",
      "AskUserQuestion",
      "ExitPlanMode",
    ]);
    const all = resolveSession({ config: CONFIG, overrides: { tools: ["*"] } }, context(FILES));
    // Then only what is taken away limits the session, the subagent tools included.
    expect(all.tools).toBeUndefined();
    expect(all.denyTools).toEqual(["Agent", "Workflow"]);
    const files = { ...FILES, [`${ROOT}/.dwa/roles/open.toml`]: 'tools = ["*"]' };
    const less = resolveSession(
      { config: CONFIG, role: "open", overrides: { deny_tools: ["WebSearch"] } },
      context(files),
    );
    expect(less.tools).toBeUndefined();
    expect(less.denyTools).toEqual(["WebSearch", "Agent", "Workflow"]);
  });

  test("a session is without the tools that start subagents unless subagents is set", () => {
    expect(SUBAGENT_TOOLS).toEqual(["Agent", "Workflow"]);
    // Nothing set anywhere: the default list has neither.
    const plain = resolveSession({ config: EMPTY_CONFIG }, context(FILES));
    expect(plain.tools).toEqual(base());
    expect(plain.denyTools).toEqual([]);
    const explore = resolveSession({ config: CONFIG, role: "explore" }, context(FILES));
    expect(explore.tools).toEqual(base("Edit", "Write"));
    // Taking one away by name changes nothing about it.
    const twice = resolveSession(
      { config: CONFIG, role: "explore", overrides: { deny_tools: ["Agent", "Bash"] } },
      context(FILES),
    );
    expect(twice.tools).toEqual(base("Bash"));
    expect(twice.denyTools).toEqual([]);
  });

  test("a built-in skill that forks a subagent by itself is off unless subagents is set", () => {
    expect(SUBAGENT_SKILLS).toEqual(["code-review"]);
    const kept = (text: string) =>
      resolveSession(
        { config: mergeConfig(CONFIG, parseConfig(`[defaults]\n${text}`, "c")) },
        context(FILES),
      );
    // Asked for by name, it is still off, and the Skill tool may not be called with it.
    const asked = kept('builtin_skills = ["code-review", "simplify"]');
    expect(asked.offSkills).toEqual(builtinOff("simplify"));
    expect(asked.allowedSkills).toEqual(["deploy", "review", "simplify"]);
    const on = kept('subagents = true\nbuiltin_skills = ["code-review"]');
    expect(on.offSkills).toEqual(builtinOff("code-review"));
    expect(on.allowedSkills).toContain("code-review");
  });

  test("built-in skills are off unless a layer keeps them by name", () => {
    expect(BUILTIN_SKILLS).toHaveLength(20);
    const plain = resolveSession({ config: EMPTY_CONFIG }, context(FILES));
    expect(plain.offSkills).toEqual([...BUILTIN_SKILLS]);
    expect(plain.allowedSkills).toEqual(["deploy", "review"]);
    const files = {
      ...FILES,
      [`${ROOT}/.dwa/roles/tidy.toml`]: 'builtin_skills = ["simplify", "dataviz"]',
      [`${ROOT}/tools/lint/.claude-plugin/plugin.json`]: '{"name":"linter"}',
    };
    const tidy = resolveSession({ config: CONFIG, role: "tidy" }, context(files));
    expect(tidy.offSkills).toEqual(builtinOff("simplify", "dataviz"));
    expect(tidy.allowedSkills).toEqual(["deploy", "review", "simplify", "dataviz"]);
    // off_skills still wins, and names a skill dwa does not know as well.
    const off = resolveSession(
      { config: CONFIG, role: "tidy", overrides: { off_skills: ["dataviz", "newcomer"] } },
      context(files),
    );
    expect(off.offSkills).toEqual([...builtinOff("simplify"), "newcomer"]);
    expect(off.allowedSkills).toEqual(["deploy", "review", "simplify"]);
    // The session's own skills go by the names the Claude command gives them: a dwa skill
    // as dwa:<name>, a plugin's by the plugin's own name.
    const reviewer = resolveSession({ config: CONFIG, role: "reviewer" }, context(files));
    expect(reviewer.allowedSkills).toEqual(["review", "dwa:house-style", "linter:*"]);
    expect(
      resolveSession({ config: CONFIG, role: "reviewer" }, context(FILES)).allowedSkills,
    ).toEqual(["review", "dwa:house-style", "lint:*"]);
  });

  test("a skill whose file asks for a fork is started as an agent, not kept as a skill", () => {
    const fork = "---\ndescription: Audits\ncontext: fork\n---\nAudit.";
    const files = {
      ...FILES,
      [`${ROOT}/.claude/skills/audit/SKILL.md`]: fork,
      [`${ROOT}/.claude/skills/review/SKILL.md`]: "",
      [`${ROOT}/.dwa/skills/house-style/SKILL.md`]: fork,
    };
    // Without a list of skills: every project skill, the forking one apart.
    const plain = resolveSession({ config: EMPTY_CONFIG }, context(files));
    expect(plain.skills).toBeUndefined();
    expect(plain.agentSkills).toEqual([
      { name: "audit", source: "project", path: `${ROOT}/.claude/skills/audit` },
    ]);
    // With a list: taken out of it, wherever the skill comes from. One the role does not
    // list is hidden as before and not offered.
    const reviewer = resolveSession({ config: CONFIG, role: "reviewer" }, context(files));
    expect(reviewer.skills?.map((skill) => skill.name)).toEqual(["review"]);
    expect(reviewer.agentSkills?.map((skill) => skill.name)).toEqual(["house-style"]);
    expect(reviewer.hiddenSkills).toContain("audit");
    expect(reviewer.hiddenSkills).not.toContain("house-style");
    // A session with subagents keeps them as the skills they are.
    const on = mergeConfig(CONFIG, parseConfig("[defaults]\nsubagents = true", "c"));
    const own = resolveSession({ config: on, role: "reviewer" }, context(files));
    expect(own.skills?.map((skill) => skill.name)).toEqual(["review", "house-style"]);
    expect(own).not.toHaveProperty("agentSkills");
    // Nothing forks: the field is absent, so a stored session still compares equal.
    expect(resolveSession({ config: EMPTY_CONFIG }, context(FILES))).not.toHaveProperty(
      "agentSkills",
    );
  });

  test("an allow list loses the subagent tools instead of gaining a deny list", () => {
    const files = { ...FILES, [`${ROOT}/.dwa/roles/lead.toml`]: 'tools = ["Read", "Agent"]' };
    const lead = resolveSession({ config: CONFIG, role: "lead" }, context(files));
    expect(lead.tools).toEqual(["Read"]);
    expect(lead.denyTools).toEqual([]);
    const both = resolveSession(
      { config: CONFIG, overrides: { tools: ["Workflow", "Read", "Agent", "Bash"] } },
      context(FILES),
    );
    expect(both.tools).toEqual(["Read", "Bash"]);
    expect(both.denyTools).toEqual([]);
  });

  test("subagents = true keeps them, from [defaults] or from the role", () => {
    const files = {
      ...FILES,
      [`${ROOT}/.dwa/roles/lead.toml`]: 'tools = ["Read", "Agent"]',
      [`${ROOT}/.dwa/roles/helper.toml`]: 'subagents = true\ndeny_tools = ["Edit"]',
      [`${ROOT}/.dwa/roles/chief.toml`]: 'subagents = true\ntools = ["Read", "Agent"]',
    };
    const on = mergeConfig(CONFIG, parseConfig("[defaults]\nsubagents = true", "c"));
    expect(resolveSession({ config: on }, context(files)).tools).toEqual([
      ...base(),
      "Agent",
      "Workflow",
    ]);
    expect(resolveSession({ config: on, role: "explore" }, context(files)).tools).toEqual([
      ...base("Edit", "Write"),
      "Agent",
      "Workflow",
    ]);
    const lead = resolveSession({ config: on, role: "lead" }, context(files));
    expect(lead.tools).toEqual(["Read", "Agent"]);
    expect(lead.denyTools).toEqual([]);

    // The same from a role, with [defaults] saying nothing.
    expect(resolveSession({ config: CONFIG, role: "helper" }, context(files)).tools).toEqual([
      ...base("Edit"),
      "Agent",
      "Workflow",
    ]);
    const chief = resolveSession({ config: CONFIG, role: "chief" }, context(files));
    expect(chief.tools).toEqual(["Read", "Agent"]);
    expect(chief.denyTools).toEqual([]);
  });

  test("a role's subagents = false takes them away again over [defaults]", () => {
    const files = {
      ...FILES,
      [`${ROOT}/.dwa/roles/quiet.toml`]: 'subagents = false\ndeny_tools = ["Edit"]',
      [`${ROOT}/.dwa/roles/narrow.toml`]: 'subagents = false\ntools = ["Read", "Agent"]',
    };
    const on = mergeConfig(CONFIG, parseConfig("[defaults]\nsubagents = true", "c"));
    expect(resolveSession({ config: on, role: "quiet" }, context(files)).tools).toEqual(
      base("Edit"),
    );
    const narrow = resolveSession({ config: on, role: "narrow" }, context(files));
    expect(narrow.tools).toEqual(["Read"]);
    expect(narrow.denyTools).toEqual([]);
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

  test("only the main session leads, and not when the config turns that off", () => {
    const ctx = context(FILES);
    expect(resolveSession({ config: CONFIG, main: true }, ctx).leader).toBe(true);
    const on = mergeConfig(CONFIG, parseConfig("[main]\nleader = true", "c"));
    expect(resolveSession({ config: on, main: true }, ctx).leader).toBe(true);
    // Absent, not false: the stored session is compared with a new one.
    const off = mergeConfig(CONFIG, parseConfig("[main]\nleader = false", "c"));
    expect("leader" in resolveSession({ config: off, main: true }, ctx)).toBe(false);
    expect("leader" in resolveSession({ config: CONFIG, role: "explore" }, ctx)).toBe(false);
    expect("leader" in resolveSession({ config: CONFIG }, ctx)).toBe(false);
    // The project's value wins over the personal one.
    const personal = parseConfig("[main]\nleader = false", "c");
    const project = parseConfig("[main]\nleader = true", "c");
    expect(resolveSession({ config: mergeConfig(personal, project), main: true }, ctx).leader).toBe(
      true,
    );
  });

  test("the role list is inherited like the prompt and is absent when it is off", () => {
    const files = {
      [`${ROOT}/.dwa/roles/lead.toml`]: 'role_list = true\nwhen_to_use = "Never."',
      [`${ROOT}/.dwa/roles/deputy.toml`]: 'extends = "lead"',
      [`${ROOT}/.dwa/roles/quiet.toml`]: 'extends = "lead"\nrole_list = false',
      [`${ROOT}/.dwa/roles/plain.toml`]: "in_role_list = false",
    };
    const resolved = (role: string) => resolveSession({ config: CONFIG, role }, context(files));
    expect(resolved("lead").roleList).toBe(true);
    expect(resolved("deputy").roleList).toBe(true);
    // Not `false`: a session stored before the field existed must compare equal to this one.
    expect("roleList" in resolved("quiet")).toBe(false);
    expect("roleList" in resolved("plain")).toBe(false);
    expect("roleList" in resolveSession({ config: CONFIG }, context(files))).toBe(false);
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
    expect(session.tools).toEqual(base("Edit", "Write", "Bash"));
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
    expect(resolve({})).toMatchObject({
      offSkills: builtinOff(),
      offPlugins: [],
      memory: true,
    });
    expect(
      resolve({ off_skills: ["pdf"], off_plugins: ["easel@builtin"], memory: false }),
    ).toMatchObject({
      offSkills: [...builtinOff(), "pdf"],
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
    expect(resolve({ off_skills: ["pdf"] }, false).offSkills).toEqual([...builtinOff(), "pdf"]);
  });

  test("can switch subagents off, but not on", () => {
    const files = {
      ...FILES,
      [`${ROOT}/.dwa/roles/helper.toml`]: 'subagents = true\ndeny_tools = ["Edit"]',
      [`${ROOT}/.dwa/roles/chief.toml`]: 'subagents = true\ntools = ["Read", "Agent"]',
    };
    const resolve = (role: string, overrides: object, config = CONFIG) =>
      resolveSession({ config, role, overrides, narrowOnly: true }, context(files));
    expect(() => resolve("explore", { subagents: true })).toThrow(ConfigError);
    expect(() => resolve("explore", { subagents: true })).toThrow(
      /Role "explore": an agent can only narrow a role, so it cannot turn subagents on/,
    );
    // Not even for a role that has them: the request is refused as such.
    expect(() => resolve("helper", { subagents: true })).toThrow(/cannot turn subagents on/);

    // Without a word about them the role's own value stands.
    expect(resolve("helper", {}).tools).toEqual([...base("Edit"), "Agent", "Workflow"]);
    expect(resolve("helper", { subagents: false }).tools).toEqual(base("Edit"));
    const chief = resolve("chief", { subagents: false });
    expect(chief.tools).toEqual(["Read"]);
    expect(chief.denyTools).toEqual([]);
    // The same over [defaults].
    const on = mergeConfig(CONFIG, parseConfig("[defaults]\nsubagents = true", "c"));
    expect(resolve("explore", {}, on).tools).toEqual([
      ...base("Edit", "Write"),
      "Agent",
      "Workflow",
    ]);
    expect(resolve("explore", { subagents: false }, on).tools).toEqual(base("Edit", "Write"));
    // Where they are off already, switching them off changes nothing.
    expect(resolve("explore", { subagents: false })).toEqual(resolve("explore", {}));
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

  test("can keep fewer built-in skills, never more", () => {
    const config = mergeConfig(
      CONFIG,
      parseConfig('[defaults]\nbuiltin_skills = ["simplify", "dataviz"]', "c"),
    );
    const resolve = (overrides: object) =>
      resolveSession({ config, role: "explore", overrides, narrowOnly: true }, context(FILES));
    expect(resolve({ builtin_skills: ["simplify"] }).offSkills).toEqual(builtinOff("simplify"));
    expect(resolve({ builtin_skills: [] }).offSkills).toEqual(builtinOff());
    expect(() => resolve({ builtin_skills: ["loop"] })).toThrow(
      /built-in skill "loop" is not part/,
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

describe("personal and project defaults", () => {
  const user = parseConfig(
    `
[defaults]
model = "haiku"
effort = "low"
tools = ["Read"]
allow = ["Bash(git log *)"]
memory = true
`,
    "user",
  );
  // The catalogues of CONFIG, which the roles name, with defaults of its own.
  const project = {
    ...CONFIG,
    defaults: parseConfig(
      '[defaults]\nmodel = "sonnet"\ndeny_tools = ["WebFetch"]\ndeny = ["Bash(rm *)"]',
      "project",
    ).defaults,
  };
  const merged = mergeConfig(user, project);
  /** The same config as it was before the personal values were kept apart. */
  const before = { ...merged, userDefaults: undefined };

  test("the two files resolve to what they did as one layer", () => {
    const expected = layerCapabilities(user.defaults, project.defaults);
    expect(expected).toEqual({
      model: "sonnet",
      effort: "low",
      // The project takes a tool away from the personal list, which stays.
      tools: ["Read"],
      deny_tools: ["WebFetch"],
      allow: ["Bash(git log *)"],
      deny: ["Bash(rm *)"],
      memory: true,
    });
    expect(resolveLayers({ config: merged }, context(FILES)).caps).toEqual(expected);
    for (const request of [{}, { role: "reviewer" }, { role: "tight" }, { main: true }]) {
      const now = resolveLayers({ config: merged, ...request }, context(FILES));
      const then = resolveLayers({ config: before, ...request }, context(FILES));
      expect(now.caps).toEqual(then.caps);
      expect(resolveSession({ config: merged, ...request }, context(FILES))).toEqual(
        resolveSession({ config: before, ...request }, context(FILES)),
      );
    }
  });

  test("origins tell the personal file from the project's", () => {
    const { origins } = resolveLayers({ config: merged }, context(FILES));
    expect(origins).toEqual({
      model: "defaults",
      deny_tools: "defaults",
      deny: "defaults",
      tools: PERSONAL_DEFAULTS,
      effort: PERSONAL_DEFAULTS,
      allow: PERSONAL_DEFAULTS,
      memory: PERSONAL_DEFAULTS,
    });
    expect(PERSONAL_DEFAULTS).toBe("personal defaults");
    // A list of tools above it would drop what was taken away, and its origin with it.
    const listed = resolveLayers(
      { config: merged, overrides: { tools: ["Bash"] } },
      context(FILES),
    ).origins;
    expect(listed.tools).toBe("session");
    expect(listed.deny_tools).toBeUndefined();

    // A role's values are the role's, whichever file had them below.
    const reviewer = resolveLayers({ config: merged, role: "reviewer" }, context(FILES)).origins;
    expect(reviewer).toMatchObject({
      model: "role reviewer",
      effort: "role reviewer",
      deny_tools: "role explore",
      allow: PERSONAL_DEFAULTS,
      deny: "defaults",
    });
    // Without a personal file nothing is called personal.
    const alone = resolveLayers({ config: mergeConfig(EMPTY_CONFIG, project) }, context(FILES));
    expect(Object.values(alone.origins)).toEqual(["defaults", "defaults", "defaults"]);
    const only = resolveLayers({ config: mergeConfig(user, EMPTY_CONFIG) }, context(FILES));
    expect(new Set(Object.values(only.origins))).toEqual(new Set([PERSONAL_DEFAULTS]));
    expect(only.caps).toEqual(user.defaults);
  });
});

describe("notes about the two places", () => {
  test("every role file is listed, the personal one the project hides included", () => {
    expect(
      listAllRoles(context(FILES)).map((role) => [role.name, role.source, role.hidden]),
    ).toEqual([
      ["explore", "project", false],
      ["explore", "user", true],
      ["personal", "user", false],
      ["reviewer", "project", false],
      ["tight", "project", false],
    ]);
  });

  test("reports a hidden personal role and a project role that starts from a personal one", () => {
    const hidden =
      'Your personal role "explore" is not used here: the project has a role of the same name.';
    expect(scopeNotes(context(FILES))).toEqual([hidden]);
    const files = {
      ...FILES,
      [`${ROOT}/.dwa/roles/child.toml`]: 'extends = "personal"',
      // Starts from the project's explore, not from the hidden personal one.
      [`${ROOT}/.dwa/roles/reader.toml`]: 'extends = "explore"',
      // A personal role may start from a personal one.
      [`${USER}/roles/mine.toml`]: 'extends = "personal"',
      // A role that does not parse is not a note.
      [`${ROOT}/.dwa/roles/broken.toml`]: "tools = 1",
    };
    expect(scopeNotes(context(files))).toEqual([
      'Role "child" is in the project but starts from your personal role "personal", ' +
        "which others who use this project do not have.",
      hidden,
    ]);
    const { [`${USER}/roles/explore.toml`]: _twin, ...rest } = FILES;
    expect(scopeNotes(context(rest))).toEqual([]);
  });
});
