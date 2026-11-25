import { findRoleIn, listRoles, type RoleContext } from "./roles.ts";

/** One role as a session that hands work over sees it. */
export interface GuideEntry {
  name: string;
  /** The role's `when_to_use`, or its `description` without one; empty when it has neither. */
  guidance: string;
  /** Why the role cannot be used: its file does not parse. */
  broken?: string;
}

/**
 * The roles a session can hand work to: every role of the project and the personal ones it
 * does not hide, without the session's own role (`except`) and without those that keep
 * themselves out with `in_role_list = false`.
 */
export function guideEntries(ctx: RoleContext, options: { except?: string } = {}): GuideEntry[] {
  const entries: GuideEntry[] = [];
  for (const entry of listRoles(ctx)) {
    if (entry.name === options.except) continue;
    try {
      const role = findRoleIn(entry, ctx)?.role;
      if (!role || role.in_role_list === false) continue;
      const guidance = role.when_to_use?.trim() || role.description?.trim() || "";
      entries.push({ name: entry.name, guidance });
    } catch (error) {
      entries.push({ name: entry.name, guidance: "", broken: (error as Error).message });
    }
  }
  return entries;
}

function line(entry: GuideEntry): string {
  if (entry.broken)
    return `- ${entry.name}: cannot be used, its file has an error (${entry.broken})`;
  if (!entry.guidance) return `- ${entry.name}`;
  const lines = entry.guidance.split("\n").map((text) => text.trimEnd());
  if (lines.length === 1) return `- ${entry.name}: ${lines[0]}`;
  return [`- ${entry.name}:`, ...lines.map((text) => (text ? `  ${text}` : ""))].join("\n");
}

/**
 * The part of a session's system prompt that lists the roles. Roles whose file is broken are
 * left out, and without any role there is no such part (an empty string).
 */
export function roleGuidePrompt(entries: GuideEntry[]): string {
  const usable = entries.filter((entry) => !entry.broken);
  if (usable.length === 0) return "";
  return [
    "# Roles you can hand work to",
    "",
    "Start one with spawn_agent (role, task). This list is from the start of your session; list_roles gives the current one.",
    "",
    ...usable.map(line),
  ].join("\n");
}

/** What `list_roles` answers: the same lines, with the roles that cannot be used named as such. */
export function roleGuideList(entries: GuideEntry[]): string {
  if (entries.length === 0) return "No roles to hand work to (.dwa/roles/*.toml).";
  return entries.map(line).join("\n");
}
