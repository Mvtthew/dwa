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
#
# The built-in role web-chrome runs with a profile of this name, which starts the command with
# its browser integration; without it that role is not offered.
# [profiles.chrome]
# command = "~/claude_me"
# args = ["--chrome"]

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

# The main session. It runs as the role "main" (the project's file, or the one built in); name
# another with role = "...". Model and effort set here win over the role's and over the profile's.
# It leads: it is told to hand work to agents and is given the roles and workflows to do it
# with. leader = false makes it an ordinary session that does the work itself.
[main]
model = "opus"
effort = "medium"       # low, medium, high, xhigh or max
# leader = false
# While it leads it is reminded (never refused) when it does a lot itself in one turn: many
# reads and searches, edits to several files, web lookups, or a test, build or lint command.
# Name the commands that count as checks here when the usual ones do not fit; [] for none.
# check_commands = ["bun test", "bun run check"]

# What every session gets unless its role says otherwise. A role's own value wins, and a value
# given for one agent or workflow step wins over the role.
[defaults]
model = "sonnet"
effort = "medium"
# permission_mode = "manual"      # manual, acceptEdits, auto, plan, dontAsk, bypassPermissions
# tools = ["Read", "Bash"]        # the only built-in tools a session has; without it: Read, Edit,
#                                 # Write, Bash, Glob, Grep, Skill, AskUserQuestion, ExitPlanMode.
#                                 # ["*"] is every tool the Claude command ships
# deny_tools = ["Edit"]           # built-in tools to take away from that list
# allow = ["Bash(git log *)"]     # permission rules allowed without asking
# deny = ["Read(.env)"]           # permission rules that are refused
# mcp = []                        # MCP servers from the catalogue above
# off_mcp = ["name"]              # servers of the project's .mcp.json to leave out
# plugins = []                    # plugins from the catalogue above
# skills = ["review"]             # only these skills, from .claude/skills, .dwa/skills or
#                                 # ~/.config/${APP_NAME}/skills; without it: every project skill
# builtin_skills = ["simplify"]   # skills built into the Claude command to keep; all are off
#                                 # otherwise (/context in a session lists them)
# off_plugins = ["name@builtin"]  # plugins built into the Claude command to switch off
# memory = true                   # let sessions use the Claude command's own project memory
# subagents = true                # let sessions use the Claude command's own subagents (the Agent
#                                 # tool); without it work is handed over with spawn_agent

# [keys]
# prefix = "C-q"        # tmux key notation

# [layout]
# status_width = 30     # columns, in a terminal of 200 columns or fewer
# agents_width = 34     # columns, likewise
# feed_width = 40       # columns of the event feed (prefix, then e, shows or hides it), likewise
# side_scale_max = 140  # how far these three grow in a wider terminal, in percent; 100: not at all
# agent_height = 40     # percent of the centre column, for the agent shown under main
# main_min_width = 90   # agents are shown right of main, two to a column, once main keeps
# agent_min_width = 70  # this many columns beside a column of that width
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
      `\nThe project uses the roles built into ${APP_NAME} (see: ${APP_NAME} role list). Copy them, a skill and example workflows into the project, to change them, with: ${APP_NAME} init --roles`,
    );
  }
  return 0;
}
