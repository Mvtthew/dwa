/** The file every skill folder has; its front matter says how the Claude command runs the skill. */
export const SKILL_FILE = "SKILL.md";

/**
 * The top-level `key: value` lines of a skill file's front matter. A value written as a YAML
 * block (`>` or `|`) or on the lines below its key is joined into one line. Not a YAML parser:
 * nested values are left out, which is enough for the few plain fields dwa reads.
 */
export function skillHeader(text: string): Record<string, string> {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header: Record<string, string> = {};
  if (lines[0]?.trim() !== "---") return header;
  let key: string | undefined;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const field = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
    if (field) {
      key = field[1] as string;
      const value = (field[2] as string).trim();
      header[key] = /^[>|][+-]?$/.test(value) ? "" : unquote(value);
    } else if (key !== undefined && /^\s+\S/.test(line)) {
      header[key] = `${header[key]} ${line.trim()}`.trim();
    }
  }
  return header;
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? (quoted[2] as string) : value;
}

/**
 * Whether the Claude command runs the skill in a subagent of its own (`context: fork`) instead
 * of in the session that calls it (docs/spikes.md, S5, "Problems found").
 */
export function runsAsAgent(text: string): boolean {
  return skillHeader(text).context === "fork";
}
