import { findRoleIn, listRoles, type RoleContext, roleProfile } from "./roles.ts";

/** One role as a session that hands work over sees it. */
export interface GuideEntry {
  name: string;
  /** The role's `when_to_use`, or its `description` without one; empty when it has neither. */
  guidance: string;
  /** Why the role cannot be used: its file does not parse. */
  broken?: string;
  /** Why no session of it can be started here: it names a profile the config does not define. */
  unavailable?: string;
}

/** What is said of a role whose profile the config does not define. */
export function missingProfile(profile: string): string {
  return `it runs with the profile "${profile}", which the config does not define ([profiles.${profile}])`;
}

/**
 * The roles a session can hand work to: every role of the project and the personal ones it
 * does not hide, without the session's own role (`except`) and without those that keep
 * themselves out with `in_role_list = false`. With `profiles` (the names the config defines) a
 * role that needs another one is marked: it cannot be started here.
 */
export function guideEntries(
  ctx: RoleContext,
  options: { except?: string; profiles?: string[] } = {},
): GuideEntry[] {
  const entries: GuideEntry[] = [];
  for (const entry of listRoles(ctx)) {
    if (entry.name === options.except) continue;
    try {
      const role = findRoleIn(entry, ctx)?.role;
      if (!role || role.in_role_list === false) continue;
      const guidance = role.when_to_use?.trim() || role.description?.trim() || "";
      const profile = roleProfile(entry.name, ctx);
      const missing =
        profile !== undefined && options.profiles && !options.profiles.includes(profile);
      entries.push({
        name: entry.name,
        guidance,
        ...(missing ? { unavailable: missingProfile(profile) } : {}),
      });
    } catch (error) {
      entries.push({ name: entry.name, guidance: "", broken: (error as Error).message });
    }
  }
  return entries;
}

function line(entry: GuideEntry): string {
  if (entry.broken)
    return `- ${entry.name}: cannot be used, its file has an error (${entry.broken})`;
  if (entry.unavailable) return `- ${entry.name}: cannot be started here, ${entry.unavailable}`;
  if (!entry.guidance) return `- ${entry.name}`;
  const lines = entry.guidance.split("\n").map((text) => text.trimEnd());
  if (lines.length === 1) return `- ${entry.name}: ${lines[0]}`;
  return [`- ${entry.name}:`, ...lines.map((text) => (text ? `  ${text}` : ""))].join("\n");
}

/**
 * The part of a session's system prompt that lists the roles. Roles whose file is broken or
 * whose profile is not defined are left out, and without any role there is no such part (an
 * empty string).
 */
export function roleGuidePrompt(entries: GuideEntry[]): string {
  const usable = entries.filter((entry) => !entry.broken && !entry.unavailable);
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

/**
 * The part of a leader's system prompt that lists the project's workflows. Without a usable
 * workflow there is no such part (an empty string).
 */
export function workflowGuidePrompt(
  workflows: { name: string; description: string | null; error: string | null }[],
): string {
  const usable = workflows.filter((workflow) => !workflow.error);
  if (usable.length === 0) return "";
  return [
    "# Workflows you can start",
    "",
    "Start one with run_workflow (name, input) when it fits the job. This list is from the start of your session; list_workflows gives the current one.",
    "",
    ...usable.map((workflow) =>
      workflow.description ? `- ${workflow.name}: ${workflow.description}` : `- ${workflow.name}`,
    ),
  ].join("\n");
}
