import { describe, expect, test } from "bun:test";
import { runsAsAgent, skillHeader } from "../src/shared/skill-file.ts";
import { skillGuidePrompt, skillTask } from "../src/shared/skill-guide.ts";

describe("skillHeader", () => {
  test("reads the plain fields of the front matter and nothing after it", () => {
    const text = [
      "---",
      "name: audit",
      'description: "Checks the release"',
      "context: fork",
      "allowed-tools:",
      "  - Read",
      "---",
      "context: inline",
    ].join("\n");
    expect(skillHeader(text)).toMatchObject({
      name: "audit",
      description: "Checks the release",
      context: "fork",
    });
  });

  test("joins a value written as a block or on the next lines", () => {
    const text =
      "---\ndescription: >\n  Checks the release\n  before it ships\nagent: reviewer\n---\n";
    expect(skillHeader(text)).toEqual({
      description: "Checks the release before it ships",
      agent: "reviewer",
    });
  });

  test("a file without front matter has none", () => {
    expect(skillHeader("context: fork\n")).toEqual({});
    expect(skillHeader("")).toEqual({});
  });
});

describe("runsAsAgent", () => {
  test("is true only for context: fork in the front matter", () => {
    expect(runsAsAgent("---\ncontext: fork\n---\nDo it.")).toBe(true);
    expect(runsAsAgent("---\r\ncontext: 'fork'\r\n---\r\n")).toBe(true);
    expect(runsAsAgent("---\ncontext: inline\n---\n")).toBe(false);
    expect(runsAsAgent("Say context: fork in the text.")).toBe(false);
  });
});

describe("skillGuidePrompt", () => {
  test("lists the skills, and is empty without any", () => {
    expect(skillGuidePrompt([])).toBe("");
    const prompt = skillGuidePrompt([
      { name: "audit", description: "Checks the release" },
      { name: "bare", description: "" },
    ]);
    expect(prompt.startsWith("# Skills that run as their own agent\n")).toBe(true);
    expect(prompt).toContain("spawn_agent with skill");
    expect(prompt.endsWith("- audit: Checks the release\n- bare")).toBe(true);
  });
});

describe("skillTask", () => {
  const skill = { name: "audit", source: "project" as const, path: "/p/.claude/skills/audit" };

  test("sends the session to the skill's file, with what it was started with", () => {
    const task = skillTask(skill, "  the release branch ");
    expect(task).toContain('run the skill "audit". Read /p/.claude/skills/audit/SKILL.md now');
    expect(task).toContain("do not call the Skill tool");
    expect(task.endsWith("\n\nthe release branch")).toBe(true);
  });

  test("needs no arguments", () => {
    expect(skillTask(skill, undefined)).not.toContain("$ARGUMENTS");
    expect(skillTask(skill, " ")).not.toContain("$ARGUMENTS");
  });
});
