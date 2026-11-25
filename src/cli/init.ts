// `dwa init`: sets a project up for dwa. It only adds files that are missing and never
// overwrites one that exists.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME } from "../shared/constants.ts";
import { projectConfigPath, rolesDir, skillsDir, workflowsDir } from "../shared/paths.ts";

const EXAMPLE_ROLES_DIR = join(import.meta.dir, "..", "..", "examples", "roles");
const EXAMPLE_SKILLS_DIR = join(import.meta.dir, "..", "..", "examples", "skills");
const EXAMPLE_WORKFLOWS_DIR = join(import.meta.dir, "..", "..", "examples", "workflows");
const IGNORE_LINE = `.${APP_NAME}/run/`;

export const CONFIG_TEMPLATE = `# ${APP_NAME} project configuration. Personal settings go in ~/.config/${APP_NAME}/config.toml;
# values here override them. Everything is optional; delete what you do not want.

# Which Claude command to run. Profiles let you switch accounts or wrappers.
# default_profile = "me"
#
# [profiles.me]
# command = "~/claude_me"
#
# [profiles.work]
# command = "~/claude_work"
# args = ["--model", "sonnet"]

# Sessions do not load your own Claude Code setup (plugins, MCP servers, skills, settings,
# personal CLAUDE.md). They get the project's own Claude files and what is set here and in the
# role files, .dwa/roles/<role>.toml. A role file takes the keys shown under [defaults], plus
# description, extends = "<another role>" and prompt. See what a role ends up with:
# ${APP_NAME} role show <role>; check everything: ${APP_NAME} config check.

# MCP servers and plugins that roles can list by name (mcp = ["github"], plugins = ["lint"]).
# [mcp.github]
# command = "github-mcp"
# args = ["serve"]
# env = { GITHUB_TOKEN = "..." }
#
# [mcp.docs]
# type = "http"
# url = "https://example.com/mcp"
#
# [plugins.lint]
# path = "tools/lint-plugin"      # a directory, relative to the project

# Agents started together with the workspace. Anything a role file can set may be set here
# too and wins over the role for this agent.
# [[agents]]
# name = "reviewer"
# role = "reviewer"
# profile = "work"
# model = "opus"
# effort = "high"
# task = "Wait for review requests."

# The main session. It runs as the role "main" when .dwa/roles/main.toml exists; name another
# with role = "...". Model and effort set here win over the role's and over the profile's.
[main]
model = "opus"
effort = "medium"       # low, medium, high, xhigh or max

# What every session gets unless its role says otherwise. A role's own value wins, and a value
# given for one agent or workflow step wins over the role.
[defaults]
model = "sonnet"
effort = "medium"
# permission_mode = "manual"      # manual, acceptEdits, auto, plan, dontAsk, bypassPermissions
# deny_tools = ["WebSearch"]      # built-in tools to remove; or tools = [...] to list the only ones
# allow = ["Bash(git log *)"]     # permission rules allowed without asking
# deny = ["Read(.env)"]           # permission rules that are refused
# mcp = []                        # MCP servers from the catalogue above
# off_mcp = ["name"]              # servers of the project's .mcp.json to leave out
# plugins = []                    # plugins from the catalogue above
# skills = ["review"]             # only these skills, from .claude/skills, .dwa/skills or
#                                 # ~/.config/${APP_NAME}/skills; without it: every project skill
# off_plugins = ["name@builtin"]  # plugins built into the Claude command to switch off, and
# off_skills = ["name"]           # built-in skills; /plugin and /skills in a session list them
# memory = true                   # let sessions use the Claude command's own project memory

# [keys]
# prefix = "C-q"        # tmux key notation

# [layout]
# status_width = 30     # columns
# agents_width = 34     # columns
# agent_height = 40     # percent of the centre column
`;

export interface InitResult {
  created: string[];
  skipped: string[];
}

export function initProject(projectRoot: string, options: { roles: boolean }): InitResult {
  const result: InitResult = { created: [], skipped: [] };
  const write = (path: string, content: string) => {
    if (existsSync(path)) {
      result.skipped.push(path);
      return;
    }
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    result.created.push(path);
  };

  write(projectConfigPath(projectRoot), CONFIG_TEMPLATE);

  if (options.roles) {
    for (const file of readdirSync(EXAMPLE_ROLES_DIR).filter((name) => name.endsWith(".toml"))) {
      write(join(rolesDir(projectRoot), file), readFileSync(join(EXAMPLE_ROLES_DIR, file), "utf8"));
    }
    // The reviewer role lists a skill, and a role with a missing skill does not start.
    for (const skill of readdirSync(EXAMPLE_SKILLS_DIR)) {
      const source = join(EXAMPLE_SKILLS_DIR, skill, "SKILL.md");
      if (!existsSync(source)) continue;
      write(join(skillsDir(projectRoot), skill, "SKILL.md"), readFileSync(source, "utf8"));
    }
    // The example workflow uses exactly these roles, so it comes with them.
    for (const file of readdirSync(EXAMPLE_WORKFLOWS_DIR).filter((name) =>
      name.endsWith(".toml"),
    )) {
      write(
        join(workflowsDir(projectRoot), file),
        readFileSync(join(EXAMPLE_WORKFLOWS_DIR, file), "utf8"),
      );
    }
  }

  // Runtime state (database, logs, generated settings) should not be committed.
  const ignorePath = join(projectRoot, ".gitignore");
  if (existsSync(join(projectRoot, ".git"))) {
    const current = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
    if (current.split("\n").some((line) => line.trim() === IGNORE_LINE)) {
      result.skipped.push(ignorePath);
    } else {
      const separator = current === "" || current.endsWith("\n") ? "" : "\n";
      writeFileSync(ignorePath, `${current}${separator}${IGNORE_LINE}\n`);
      result.created.push(`${ignorePath} (added ${IGNORE_LINE})`);
    }
  }
  return result;
}

export function initCommand(projectRoot: string, args: string[]): number {
  const result = initProject(projectRoot, { roles: args.includes("--roles") });
  for (const path of result.created) console.log(`created  ${path}`);
  for (const path of result.skipped) console.log(`kept     ${path}`);
  if (!args.includes("--roles")) {
    console.log(
      `\nAdd example roles (main, explore, developer, reviewer), a skill and a workflow that use them with: ${APP_NAME} init --roles`,
    );
  }
  return 0;
}
