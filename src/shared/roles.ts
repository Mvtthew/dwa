import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Effort levels the Claude command accepts with `--effort`. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface SessionTuning {
  model?: string;
  effort?: string;
}

/** Reads `model` and `effort` from the frontmatter of an agent definition. */
export function parseRoleTuning(text: string): SessionTuning {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return {};
  const tuning: SessionTuning = {};
  for (const line of lines.slice(1, end)) {
    const match = /^(model|effort):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = (match[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
    // "inherit" means "whatever the session would use anyway".
    if (value && value !== "inherit") tuning[match[1] as "model" | "effort"] = value;
  }
  return tuning;
}

/**
 * What a role's own definition says about model and effort: the project's
 * `.claude/agents/<role>.md`, otherwise the personal one. Only ever read, never written.
 */
export function roleTuning(projectRoot: string, role: string): SessionTuning {
  if (!/^[\w.-]+$/.test(role)) return {};
  for (const dir of [
    join(projectRoot, ".claude", "agents"),
    join(homedir(), ".claude", "agents"),
  ]) {
    const path = join(dir, `${role}.md`);
    if (existsSync(path)) return parseRoleTuning(readFileSync(path, "utf8"));
  }
  return {};
}

/**
 * Model and effort for a new session. A value given for this agent wins, then the role's own
 * definition, then the configured defaults; with none of them nothing is passed and the Claude
 * command decides.
 */
export function resolveTuning(
  explicit: SessionTuning,
  role: SessionTuning,
  defaults: SessionTuning,
): SessionTuning {
  return {
    model: explicit.model ?? role.model ?? defaults.model,
    effort: explicit.effort ?? role.effort ?? defaults.effort,
  };
}
