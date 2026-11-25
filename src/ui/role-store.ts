// The role settings' access to the files: the real one, for the popup.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../shared/config.ts";
import { diffLines, readHistory, switchTo, versionText } from "../shared/history.ts";
import { projectSkillsDir, skillsDir, userSkillsDir } from "../shared/paths.ts";
import {
  createRole,
  deleteRole,
  duplicateRole,
  noticeEdits,
  renameRole,
  roleHistory,
  roleTemplate,
  roleUsers,
  saveValues,
} from "../shared/role-edit.ts";
import { findRole, listRoles, parseRole, type RoleContext } from "../shared/roles.ts";
import type { RoleStore } from "./role-screens.ts";

function skillNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, "SKILL.md")));
}

function projectServers(projectRoot: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(projectRoot, ".mcp.json"), "utf8"));
    return Object.keys(parsed?.mcpServers ?? parsed ?? {});
  } catch {
    return [];
  }
}

export function diskRoleStore(projectRoot: string, config: Config | null): RoleStore {
  const ctx: RoleContext = { projectRoot };
  // Whatever was changed in an editor since the last look gets its version first.
  noticeEdits(ctx);
  const SOURCE = "role settings";
  return {
    list: () =>
      listRoles(ctx).map((entry) => {
        try {
          const role = findRole(entry.name, ctx)?.role;
          return {
            name: entry.name,
            personal: entry.source === "user",
            description: role?.description ?? null,
            error: null,
          };
        } catch (error) {
          return {
            name: entry.name,
            personal: entry.source === "user",
            description: null,
            error: (error as Error).message,
          };
        }
      }),
    load: (name) => {
      const loaded = findRole(name, ctx);
      if (!loaded) throw new Error(`Unknown role "${name}".`);
      return loaded.role;
    },
    save: (name, changes) => saveValues({ kind: "role", name }, changes, SOURCE, ctx).n,
    create: (name, description) => {
      createRole(name, roleTemplate(description), SOURCE, ctx);
    },
    duplicate: (from, to) => {
      duplicateRole(from, to, ctx);
    },
    rename: (from, to) => {
      renameRole(from, to, ctx);
    },
    remove: (name) => deleteRole(name, ctx),
    users: (name) => roleUsers(name, ctx),
    history: (name) => readHistory(roleHistory(name, ctx)),
    diff: (name, from, to) => {
      const tracked = roleHistory(name, ctx);
      const lines = diffLines(versionText(tracked, from), versionText(tracked, to));
      return lines.length > 0 ? lines : ["No differences."];
    },
    switchTo: (name, n) => {
      const tracked = roleHistory(name, ctx);
      // A version that is no longer a valid role is not brought back.
      parseRole(versionText(tracked, n), `v${n}`);
      switchTo(tracked, n);
    },
    choices: () => ({
      mcp: Object.keys(config?.mcp ?? {}),
      plugins: Object.keys(config?.plugins ?? {}),
      skills: [
        ...new Set([
          ...skillNames(projectSkillsDir(projectRoot)),
          ...skillNames(skillsDir(projectRoot)),
          ...skillNames(userSkillsDir()),
        ]),
      ],
      projectMcp: projectServers(projectRoot),
    }),
  };
}
