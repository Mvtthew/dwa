import { join } from "node:path";
import { diskFiles, type ResolvedSkill, type RoleContext } from "./roles.ts";
import { SKILL_FILE, skillHeader } from "./skill-file.ts";

/** A skill that runs as an agent of its own, as a session that can start it sees it. */
export interface SkillGuideEntry {
  name: string;
  /** The skill's `description`; empty when it has none. */
  description: string;
}

/** Reads what the list says about each skill from its file. */
export function skillGuideEntries(skills: ResolvedSkill[], ctx: RoleContext): SkillGuideEntry[] {
  const files = ctx.files ?? diskFiles;
  return skills.map((skill) => ({
    name: skill.name,
    description: skillHeader(files.read(join(skill.path, SKILL_FILE)) ?? "").description ?? "",
  }));
}

/**
 * The part of a session's system prompt that lists the skills it starts as agents; without
 * any there is no such part (an empty string).
 */
export function skillGuidePrompt(entries: SkillGuideEntry[]): string {
  if (entries.length === 0) return "";
  return [
    "# Skills that run as their own agent",
    "",
    "These skills ask for a separate agent, so the Skill tool does not have them in this workspace. Run one by starting a session for it: spawn_agent with skill set to its name and task saying what it should work on (what you would pass the skill as arguments, and what it needs to know). Add a role when one fits the work. Get the result with wait_for.",
    "",
    ...entries.map((entry) =>
      entry.description ? `- ${entry.name}: ${entry.description}` : `- ${entry.name}`,
    ),
  ].join("\n");
}

/**
 * The first prompt of a session started to run a skill (`spawn_agent` with `skill`). The
 * session reads the skill's file itself: the Claude command would run the skill in a subagent
 * again, out of the workspace's sight.
 */
export function skillTask(skill: ResolvedSkill, task: string | undefined): string {
  const file = join(skill.path, SKILL_FILE);
  const lines = [
    `Your task is to run the skill "${skill.name}". Read ${file} now and do what it says, in this session: you are the separate agent it asks for, so do not call the Skill tool for it. Files it names are in ${skill.path}. Its front matter (the lines between the "---" marks at the top) is settings for the Skill tool, not instructions.`,
  ];
  if (task?.trim()) {
    lines.push(
      "",
      "What it was started with (the skill's arguments, $ARGUMENTS in its text):",
      "",
      task.trim(),
    );
  }
  return lines.join("\n");
}
