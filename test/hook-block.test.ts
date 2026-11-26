import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localVerdict, reminderOutput, skillVerdict } from "../src/cli/hook.ts";
import { approvesOwnTool, skillRefusal } from "../src/shared/tools.ts";

let dir: string;
const list = (text: string) => {
  mkdirSync(join(dir, ".dwa", "run", "agents", "id-3"), { recursive: true });
  writeFileSync(join(dir, ".dwa", "run", "agents", "id-3", "blocked.json"), text);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dwa-hook-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the hook's own list of refused tools", () => {
  test("no list leaves the decision to the daemon", () => {
    expect(localVerdict(dir, "id-3", "Bash")).toBeUndefined();
  });

  test("refuses what is listed, without the daemon, and lets the rest through", () => {
    list(JSON.stringify(["Bash", "mcp__notes"]));
    expect(localVerdict(dir, "id-3", "Bash")).toContain("Bash was switched off");
    expect(localVerdict(dir, "id-3", "mcp__notes__search")).toContain("The MCP server notes");
    expect(localVerdict(dir, "id-3", "Read")).toBeNull();
    list("[]");
    expect(localVerdict(dir, "id-3", "Bash")).toBeNull();
  });

  test("a list that cannot be read refuses the call", () => {
    list("{ half");
    expect(localVerdict(dir, "id-3", "Read")).toContain("could not be read");
    list(JSON.stringify({ Bash: true }));
    expect(localVerdict(dir, "id-3", "Read")).toContain("could not be read");
  });
});

describe("the skills a session was given", () => {
  const skills = (text: string) => {
    mkdirSync(join(dir, ".dwa", "run", "agents", "id-3"), { recursive: true });
    writeFileSync(join(dir, ".dwa", "run", "agents", "id-3", "skills.json"), text);
  };
  const call = (skill: unknown) => skillVerdict(dir, "id-3", { tool_input: { skill } });

  test("a skill by its name, a plugin's skills by the plugin, nothing else", () => {
    const allowed = ["review", "dwa:house-style", "lint:*"];
    expect(skillRefusal("review", allowed)).toBeNull();
    expect(skillRefusal("/review", allowed)).toBeNull();
    expect(skillRefusal("dwa:house-style", allowed)).toBeNull();
    expect(skillRefusal("lint:fix", allowed)).toBeNull();
    // A built-in skill dwa has never heard of is refused like any other.
    const refusal = skillRefusal("brand-new", allowed);
    expect(refusal).toContain('The skill "brand-new" is not one this session was given');
    expect(refusal).toContain("It has: review, dwa:house-style, lint:*.");
    expect(skillRefusal("house-style", allowed)).not.toBeNull();
    expect(skillRefusal("linter:fix", allowed)).not.toBeNull();
    expect(skillRefusal("simplify", [])).toContain("It has no skills.");
  });

  test("the hook reads the list from the session's run folder", () => {
    // No list: a session from before dwa wrote one is left alone.
    expect(call("simplify")).toBeNull();
    skills(JSON.stringify(["review"]));
    expect(call("review")).toBeNull();
    expect(call("simplify")).toContain("is not one this session was given");
    // Not a call the hook understands: left to the Claude command.
    expect(call(undefined)).toBeNull();
    skills("{ half");
    expect(call("review")).toContain("could not be read");
  });
});

describe("permission requests the hook answers itself", () => {
  test("only dwa's own tools, and only in plan mode", () => {
    const ask = (tool_name: unknown, permission_mode: unknown) =>
      approvesOwnTool({ tool_name, permission_mode });
    expect(ask("mcp__dwa__spawn_agent", "plan")).toBe(true);
    expect(ask("mcp__dwa__list_agents", "plan")).toBe(true);
    expect(ask("mcp__dwa__spawn_agent", "manual")).toBe(false);
    expect(ask("mcp__dwa__spawn_agent", undefined)).toBe(false);
    expect(ask("mcp__dwarf__dig", "plan")).toBe(false);
    expect(ask("mcp__notes__search", "plan")).toBe(false);
    expect(ask("Bash", "plan")).toBe(false);
    expect(ask(undefined, "plan")).toBe(false);
    expect(approvesOwnTool(null)).toBe(false);
  });
});

describe("the reminder for a session that leads", () => {
  test("is handed to the model after a tool call, as context and never as a refusal", () => {
    expect(reminderOutput("PostToolUse", "[dwa] Hand it over.")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "[dwa] Hand it over.",
      },
    });
    expect(reminderOutput("PostToolUseFailure", "x")).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: "x" },
    });
    expect(JSON.stringify(reminderOutput("PostToolUse", "x"))).not.toContain("permissionDecision");
  });

  test("nothing is printed for another event or without a text", () => {
    // Before the call the text would come no earlier, and is lost when the user declines.
    for (const event of ["PreToolUse", "Stop", "UserPromptSubmit", "SessionStart"]) {
      expect(reminderOutput(event, "x")).toBeNull();
    }
    for (const context of [undefined, null, "", 3, {}]) {
      expect(reminderOutput("PostToolUse", context)).toBeNull();
    }
  });
});
