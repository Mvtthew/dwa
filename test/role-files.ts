import type { RoleFiles } from "../src/shared/roles.ts";

/**
 * Role files for tests of the workspace, which sits at `/project`: every role name has a file,
 * empty unless `roles` gives its TOML text. `others` are further files by full path, and
 * `commands` what is found on PATH.
 */
export function testRoleFiles(
  roles: Record<string, string> = {},
  others: Record<string, string> = {},
  commands: string[] = [],
): RoleFiles {
  const role = (path: string) => /^\/project\/\.dwa\/roles\/([\w.-]+)\.toml$/.exec(path)?.[1];
  const known = (path: string) =>
    Object.keys(others).some((file) => file === path || file.startsWith(`${path}/`));
  return {
    read: (path) => {
      const name = role(path);
      // "main" is used only when its file exists, so it is not made up like the others.
      if (name !== undefined) return roles[name] ?? (name === "main" ? null : "");
      return others[path] ?? null;
    },
    exists: (path) => role(path) !== undefined || known(path),
    list: (dir) => {
      if (dir === "/project/.dwa/roles") return Object.keys(roles).map((name) => `${name}.toml`);
      const inside = Object.keys(others).filter((file) => file.startsWith(`${dir}/`));
      return [...new Set(inside.map((file) => file.slice(dir.length + 1).split("/")[0] as string))];
    },
    which: (command) => (commands.includes(command) ? `/bin/${command}` : null),
  };
}
