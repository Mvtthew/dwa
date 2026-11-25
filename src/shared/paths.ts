import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { APP_NAME } from "./constants.ts";

type Env = Record<string, string | undefined>;

/** Expands a leading `~` and `$VAR` / `${VAR}` references, as a shell would for a command path. */
export function expandPath(input: string, env: Env = process.env): string {
  let result = input;
  if (result === "~" || result.startsWith("~/")) {
    result = join(homedir(), result.slice(1));
  }
  return result.replace(
    /\$(?:\{(\w+)\}|(\w+))/g,
    (_, braced: string | undefined, bare: string | undefined) => env[braced ?? bare ?? ""] ?? "",
  );
}

/** Personal config: `$XDG_CONFIG_HOME/dwa/config.toml`, by default `~/.config/dwa/config.toml`. */
export function userConfigPath(env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, APP_NAME, "config.toml");
}

/** Personal directory for dwa files, next to the personal config: `~/.config/dwa`. */
export function userDir(env: Env = process.env): string {
  return dirname(userConfigPath(env));
}

/** Project directory for dwa files: `<project>/.dwa`. */
export function projectDir(projectRoot: string): string {
  return join(projectRoot, `.${APP_NAME}`);
}

/** Project config, which overrides the personal one: `<project>/.dwa/config.toml`. */
export function projectConfigPath(projectRoot: string): string {
  return join(projectDir(projectRoot), "config.toml");
}

/** Workflow definitions, one TOML file each: `<project>/.dwa/workflows`. */
export function workflowsDir(projectRoot: string): string {
  return join(projectDir(projectRoot), "workflows");
}

/** Role files, one TOML file each: `<project>/.dwa/roles`. */
export function rolesDir(projectRoot: string): string {
  return join(projectDir(projectRoot), "roles");
}

/** Personal roles, used when the project has none of that name: `~/.config/dwa/roles`. */
export function userRolesDir(env: Env = process.env): string {
  return join(userDir(env), "roles");
}

/** Skills kept for dwa sessions, one directory each: `<project>/.dwa/skills`. */
export function skillsDir(projectRoot: string): string {
  return join(projectDir(projectRoot), "skills");
}

/** Personal skills for dwa sessions: `~/.config/dwa/skills`. */
export function userSkillsDir(env: Env = process.env): string {
  return join(userDir(env), "skills");
}

/** The project's own Claude Code skills, which every session may load: `<project>/.claude/skills`. */
export function projectSkillsDir(projectRoot: string): string {
  return join(projectRoot, ".claude", "skills");
}

/**
 * Earlier versions of role files and of the config, numbered, so a change can be looked at
 * and taken back: `<project>/.dwa/history`. Meant to be committed with the files it follows.
 */
export function historyDir(projectRoot: string): string {
  return join(projectDir(projectRoot), "history");
}

/** History of the personal roles and config: `~/.config/dwa/history`. */
export function userHistoryDir(env: Env = process.env): string {
  return join(userDir(env), "history");
}

/** Runtime state that is never committed (database, logs, generated settings): `<project>/.dwa/run`. */
export function runDir(projectRoot: string): string {
  return join(projectDir(projectRoot), "run");
}

/**
 * The project a command applies to: `$DWA_PROJECT` when set (panes started by dwa have it),
 * otherwise the nearest parent of `cwd` holding `.dwa` or `.git`, otherwise `cwd` itself.
 */
export function findProjectRoot(cwd: string = process.cwd(), env: Env = process.env): string {
  if (env.DWA_PROJECT) return resolve(env.DWA_PROJECT);
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, `.${APP_NAME}`)) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/** Short stable id for a project path, used to keep one daemon and one tmux server per project. */
export function projectHash(projectRoot: string): string {
  return new Bun.CryptoHasher("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 10);
}

/** Name of the private tmux server socket for a project (`tmux -L <name>`). */
export function tmuxSocketName(projectRoot: string): string {
  return `${APP_NAME}-${projectHash(projectRoot)}`;
}

/** Directory for daemon sockets. Kept short because Unix socket paths are limited to about 100 bytes. */
export function socketDir(): string {
  return join("/tmp", `${APP_NAME}-${process.getuid?.() ?? "user"}`);
}

/** The daemon's Unix socket for a project. */
export function daemonSocketPath(projectRoot: string): string {
  return join(socketDir(), `${projectHash(projectRoot)}.sock`);
}
