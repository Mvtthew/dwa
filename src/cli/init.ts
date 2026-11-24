// `dwa init`: sets a project up for dwa. It only adds files that are missing and never
// overwrites one that exists.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME } from "../shared/constants.ts";
import { projectConfigPath } from "../shared/paths.ts";

const EXAMPLE_ROLES_DIR = join(import.meta.dir, "..", "..", "examples", "agents");
const IGNORE_LINE = `.${APP_NAME}/run/`;

export const CONFIG_TEMPLATE = `# ${APP_NAME} project configuration. Personal settings go in ~/.config/${APP_NAME}/config.toml;
# values here override them. Everything is optional.

# Which Claude command to run. Profiles let you switch accounts or wrappers.
# default_profile = "me"
#
# [profiles.me]
# command = "~/claude_me"
#
# [profiles.work]
# command = "~/claude_work"
# args = ["--model", "sonnet"]

# Agents started together with the workspace. "role" is an agent definition
# in .claude/agents/<role>.md.
# [[agents]]
# name = "reviewer"
# role = "reviewer"
# profile = "work"
# task = "Wait for review requests."

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
    for (const file of readdirSync(EXAMPLE_ROLES_DIR).filter((name) => name.endsWith(".md"))) {
      write(
        join(projectRoot, ".claude", "agents", file),
        readFileSync(join(EXAMPLE_ROLES_DIR, file), "utf8"),
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
      `\nAdd example agent roles (explore, developer, reviewer) with: ${APP_NAME} init --roles`,
    );
  }
  return 0;
}
