import { homedir } from "node:os";
import { join } from "node:path";
import { APP_NAME } from "./constants.ts";

/** Expands a leading `~` and `$VAR` / `${VAR}` references, as a shell would for a command path. */
export function expandPath(
  input: string,
  env: Record<string, string | undefined> = process.env,
): string {
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
export function userConfigPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, APP_NAME, "config.toml");
}

/** Project directory for dwa files: `<project>/.dwa`. */
export function projectDir(projectRoot: string): string {
  return join(projectRoot, `.${APP_NAME}`);
}

/** Project config, which overrides the personal one: `<project>/.dwa/config.toml`. */
export function projectConfigPath(projectRoot: string): string {
  return join(projectDir(projectRoot), "config.toml");
}

/** Runtime state that is never committed (socket, database, generated settings): `<project>/.dwa/run`. */
export function runDir(projectRoot: string): string {
  return join(projectDir(projectRoot), "run");
}
