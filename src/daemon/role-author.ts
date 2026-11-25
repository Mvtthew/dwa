// Roles written by an agent: the session that writes one from the user's description, and the
// one way its text becomes a role file.
import type { Config } from "../shared/config.ts";
import { APP_NAME } from "../shared/constants.ts";
import type { AgentInfo } from "../shared/protocol.ts";
import {
  checkRoleText,
  createRole,
  noticeEdits,
  requireFreeRoleName,
  saveRoleText,
} from "../shared/role-edit.ts";
import { listAllRoles, type Role } from "../shared/roles.ts";
import { formatRef, type Scope } from "../shared/scope.ts";
import type { Store } from "./db.ts";
import { WorkspaceError } from "./errors.ts";
import { USER } from "./messaging.ts";
import type { Workspace } from "./workspace.ts";

/** The role of the session that writes roles from a description. */
export const ROLE_AUTHOR_ROLE = "role-author";

/** What saving a role file for an agent did. */
export interface SavedRole {
  name: string;
  path: string;
  version: number;
  created: boolean;
}

export interface RoleAuthorDeps {
  store: Store;
  workspace: Workspace;
  loadConfig: () => Promise<Config>;
  /** Where the personal folder is looked up; the process's own environment when left out. */
  env?: Record<string, string | undefined>;
}

/** Where the store keeps which role a session was started to write. */
function targetKey(agentId: string): string {
  return `role-author:${agentId}`;
}

/** What the role's own file gives a session, in one line for the user. */
function grants(role: Role): string {
  const parts: string[] = [];
  if (role.extends) parts.push(`starts from ${role.extends}`);
  if (role.model) parts.push(`model ${role.model}`);
  if (role.permission_mode) parts.push(`permissions ${role.permission_mode}`);
  if (role.tools) parts.push(`tools ${role.tools.join(", ") || "none"}`);
  else if (role.deny_tools?.length) parts.push(`all tools except ${role.deny_tools.join(", ")}`);
  else if (!role.extends) parts.push("all tools");
  if (role.allow?.length) parts.push(`allows ${role.allow.join(", ")}`);
  if (role.mcp?.length) parts.push(`mcp ${role.mcp.join(", ")}`);
  if (role.plugins?.length) parts.push(`plugins ${role.plugins.join(", ")}`);
  if (role.memory) parts.push("memory on");
  if (role.subagents) parts.push("subagents on");
  return parts.join("; ");
}

export class RoleAuthor {
  constructor(private readonly deps: RoleAuthorDeps) {}

  private get ctx() {
    return { projectRoot: this.deps.workspace.projectRoot, env: this.deps.env };
  }

  /** Starts the session that writes a role from a description and stays to refine it. */
  async author(
    description: string,
    /** The name and the place the user chose. */
    wanted: { name: string; personal?: boolean },
  ): Promise<AgentInfo> {
    const { store, workspace } = this.deps;
    const { name, personal = false } = wanted;
    requireFreeRoleName(name, this.ctx);
    if (workspace.unknownRoles([ROLE_AUTHOR_ROLE]).length > 0) {
      throw new WorkspaceError(
        `This project has no role "${ROLE_AUTHOR_ROLE}", which writes roles. Add it with: ${APP_NAME} init --roles`,
      );
    }
    const where = [
      `Save it under the name "${name}".`,
      personal ? "Save it as a personal role (personal: true)." : "",
    ]
      .filter(Boolean)
      .join(" ");
    const agent = await workspace.spawn({
      role: ROLE_AUTHOR_ROLE,
      task: `Write a role for this project and save it with save_role. ${where}\n\nWhat it is for: ${description}`,
    });
    // The one role file this session may write, kept in the store so that it holds after a
    // restart of the daemon.
    store.setMeta(targetKey(agent.id), formatRef({ name, source: personal ? "user" : "project" }));
    // The user asked for this session and will talk to it, so it is shown at once.
    return workspace.open(agent.name).catch(() => agent);
  }

  /**
   * Writes a role file with a text an agent made: checked, with a version in the history like
   * every other change, and the user is told. A role decides what a session may do, so only the
   * session `author` started may save, and only the role it was started for. A role that is new
   * is shown to the user in the role settings; one that is changed is not, so that a popup never
   * interrupts twice.
   */
  async saveFile(name: string, text: string, byId: string, personal = false): Promise<SavedRole> {
    const { store, workspace } = this.deps;
    const ctx = this.ctx;
    const source: Scope = personal ? "user" : "project";
    const ref = formatRef({ name, source });
    const agent = byId === USER ? null : store.getRunning(byId);
    const target = agent?.role === ROLE_AUTHOR_ROLE ? store.getMeta(targetKey(agent.id)) : null;
    if (!agent || target === null) {
      throw new WorkspaceError(
        `Only the session started by "Describe it to an agent" in the role settings saves a role. Others ask the user to change roles there, or with: ${APP_NAME} role`,
      );
    }
    if (target !== ref) {
      throw new WorkspaceError(
        `You were started to write the role ${target} and may save only that one, not ${ref}.`,
      );
    }
    noticeEdits(ctx);
    const existing = listAllRoles(ctx).find(
      (entry) => entry.name === name && entry.source === source,
    );
    if (!existing) requireFreeRoleName(name, ctx);
    const role = checkRoleText({ name, source }, text, await this.deps.loadConfig(), ctx);
    const who = `agent ${agent.name}`;
    let path: string;
    let version = 1;
    if (existing) {
      version = saveRoleText({ name, source }, text, who, ctx).n;
      path = existing.path;
    } else {
      path = createRole(name, text, who, ctx, { personal }).path;
    }
    try {
      // Sent as the agent: it is the one who did it, and the user can answer it.
      workspace.messaging.send(
        agent.id,
        USER,
        `${existing ? `Changed role "${name}" (now v${version})` : `Wrote a new role "${name}"`}: ${grants(role)}\nLook at it with: ${APP_NAME} role show ${name}`,
      );
    } catch (error) {
      console.error(error);
    }
    if (!existing) workspace.popup("roles", ref);
    return { name, path, version, created: !existing };
  }
}
