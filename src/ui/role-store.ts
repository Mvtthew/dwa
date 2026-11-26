// The role settings' access to the files: the real one, for the popup.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../shared/config.ts";
import { diffLines, readHistory, switchTo, versionText } from "../shared/history.ts";
import { projectSkillsDir, skillsDir, userSkillsDir } from "../shared/paths.ts";
import {
  adoptRole,
  createRole,
  deleteRole,
  duplicateRole,
  moveRole,
  noticeEdits,
  renameRole,
  requireRole,
  roleHistory,
  roleTemplate,
  roleUsers,
  saveValues,
  scopeWarnings,
} from "../shared/role-edit.ts";
import {
  findRoleIn,
  listAllRoles,
  listRoles,
  parseRole,
  type RoleContext,
} from "../shared/roles.ts";
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

export function diskRoleStore(
  projectRoot: string,
  config: Config | null,
  env?: Record<string, string | undefined>,
): RoleStore {
  const ctx: RoleContext = { projectRoot, env };
  // Whatever was changed in an editor since the last look gets its version first.
  noticeEdits(ctx);
  const SOURCE = "role settings";
  return {
    list: () =>
      listAllRoles(ctx).map((entry) => {
        const { name, source, hidden } = entry;
        try {
          const description = findRoleIn(entry, ctx)?.role.description ?? null;
          return { name, source, hidden, description, error: null };
        } catch (error) {
          return { name, source, hidden, description: null, error: (error as Error).message };
        }
      }),
    builtins: () =>
      listRoles(ctx)
        .filter((entry) => entry.source === "builtin")
        .map((entry) => {
          try {
            const role = findRoleIn(entry, ctx)?.role;
            return {
              name: entry.name,
              description: role?.description ?? null,
              whenToUse: role?.when_to_use ?? null,
            };
          } catch {
            return { name: entry.name, description: null, whenToUse: null };
          }
        }),
    adopt: (name, where) => {
      adoptRole(name, ctx, { personal: where === "user" });
    },
    load: (role) => {
      const loaded = findRoleIn(requireRole(role, ctx), ctx);
      if (!loaded) throw new Error("The role file is gone.");
      return loaded.role;
    },
    save: (role, changes) => {
      const { name, source } = requireRole(role, ctx);
      return saveValues({ kind: "role", name, source }, changes, SOURCE, ctx).n;
    },
    create: (name, description, where) => {
      createRole(name, roleTemplate(description), SOURCE, ctx, { personal: where === "user" });
    },
    duplicate: (from, to, where) => {
      duplicateRole(from, to, ctx, where ? { personal: where === "user" } : {});
    },
    rename: (from, to) => {
      renameRole(from, to, ctx);
    },
    move: (role, to) => {
      moveRole(role, to, ctx);
    },
    remove: (role) => deleteRole(role, ctx),
    users: (role) => roleUsers(role, ctx),
    warnings: (action, role) => scopeWarnings(action, role, ctx),
    history: (role) => readHistory(roleHistory(role, ctx)),
    diff: (role, from, to) => {
      const tracked = roleHistory(role, ctx);
      const lines = diffLines(versionText(tracked, from), versionText(tracked, to));
      return lines.length > 0 ? lines : ["No differences."];
    },
    switchTo: (role, n) => {
      const tracked = roleHistory(role, ctx);
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
          ...skillNames(userSkillsDir(env)),
        ]),
      ],
      projectMcp: projectServers(projectRoot),
    }),
  };
}
