import { describe, expect, test } from "bun:test";
import {
  afterCall,
  isCheckCommand,
  NUDGE_AT,
  type NudgeKind,
  type NudgeState,
  newTurn,
  nudgeText,
  type ToolCall,
} from "../src/shared/nudge.ts";

/** Feeds the calls in order and returns the reminders that came, with the state at the end. */
function run(calls: ToolCall[], from: NudgeState = newTurn(), checks?: string[]) {
  let state = from;
  const kinds: (NudgeKind | undefined)[] = [];
  for (const call of calls) {
    const result = afterCall(state, call, checks);
    state = result.state;
    kinds.push(result.kind);
  }
  return { state, kinds, fired: kinds.filter((kind) => kind !== undefined) };
}

const reads = (count: number): ToolCall[] =>
  Array.from({ length: count }, (_, i) => ({ tool: ["Read", "Grep", "Glob"][i % 3] as string }));
const edit = (path: string, tool = "Edit"): ToolCall => ({ tool, input: { file_path: path } });
const bash = (command: string): ToolCall => ({ tool: "Bash", input: { command } });

describe("reminders for a session that leads", () => {
  test("many reads and searches in a turn bring one, once", () => {
    const { kinds } = run(reads(NUDGE_AT.reads + 4));
    expect(kinds.indexOf("reads")).toBe(NUDGE_AT.reads - 1);
    expect(kinds.filter(Boolean)).toEqual(["reads"]);
  });

  test("edits count files, not calls", () => {
    const same = run([edit("a.ts"), edit("a.ts"), edit("a.ts"), edit("a.ts")]);
    expect(same.fired).toEqual([]);
    const several = run([edit("a.ts"), edit("b.ts", "Write"), edit("a.ts"), edit("c.ts")]);
    expect(several.kinds).toEqual([undefined, undefined, undefined, "edits"]);
    expect(several.state.edited).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("a check command brings one at once, other commands none", () => {
    expect(run([bash("git status"), bash("ls src")]).fired).toEqual([]);
    expect(run([bash("bun test test/a.test.ts"), bash("bun run lint")]).fired).toEqual(["checks"]);
  });

  test("web lookups bring one at the third", () => {
    const calls = [{ tool: "WebSearch" }, { tool: "WebFetch" }, { tool: "WebSearch" }];
    expect(run(calls).kinds).toEqual([undefined, undefined, "web"]);
  });

  test("each kind comes on its own", () => {
    const calls = [...reads(NUDGE_AT.reads), bash("npm test"), edit("a"), edit("b"), edit("c")];
    expect(run(calls).fired).toEqual(["reads", "checks", "edits"]);
  });

  test("none after the session has handed work over in this turn", () => {
    const spawned = run([{ tool: "mcp__dwa__spawn_agent" }]).state;
    expect(spawned.delegated).toBe(true);
    expect(
      run([...reads(20), bash("bun test"), edit("a"), edit("b"), edit("c")], spawned).fired,
    ).toEqual([]);
    expect(run([{ tool: "mcp__dwa__run_workflow" }, ...reads(20)]).fired).toEqual([]);
    // Other tools of the workspace are not handing over.
    expect(run([{ tool: "mcp__dwa__list_agents" }, ...reads(NUDGE_AT.reads)]).fired).toEqual([
      "reads",
    ]);
  });

  test("a new turn starts from nothing", () => {
    const first = run(reads(NUDGE_AT.reads));
    expect(first.fired).toEqual(["reads"]);
    expect(run(reads(NUDGE_AT.reads - 1), newTurn()).fired).toEqual([]);
    expect(run(reads(NUDGE_AT.reads), newTurn()).fired).toEqual(["reads"]);
  });

  test("tools that are none of these change nothing", () => {
    const { state, fired } = run([{ tool: "AskUserQuestion" }, { tool: "mcp__github__search" }]);
    expect(fired).toEqual([]);
    expect(state).toEqual(newTurn());
  });
});

describe("check commands", () => {
  test("are recognised at the start of any part of a command", () => {
    for (const command of [
      "bun test",
      "bun run check",
      "cd app && npm run build",
      "pnpm test -- --watch=false",
      "cargo clippy --all",
      "git status; make test",
      "npx tsc --noEmit | tail -5",
      "./gradlew build",
    ]) {
      expect([command, isCheckCommand(command)]).toEqual([command, true]);
    }
  });

  test("and nothing else is", () => {
    for (const command of [
      "",
      "git log --oneline",
      "bun run dwa status",
      "bun install",
      "cat Makefile",
      "makefile-lint",
      "echo bun test",
      "grep -r 'npm test' docs",
    ]) {
      expect([command, isCheckCommand(command)]).toEqual([command, false]);
    }
  });

  test("the config's list takes the place of the usual one", () => {
    const checks = ["just verify", "dotnet test"];
    expect(isCheckCommand("just verify --fast", checks)).toBe(true);
    expect(isCheckCommand("bun test", checks)).toBe(false);
    expect(run([bash("just verify")], newTurn(), checks).fired).toEqual(["checks"]);
    expect(isCheckCommand("anything", [])).toBe(false);
    expect(isCheckCommand("anything", [""])).toBe(false);
  });
});

describe("what a reminder says", () => {
  test("names the role for the work when there is one here", () => {
    const roles = ["explore", "quick", "developer", "runner", "web-research"];
    expect(nudgeText("reads", roles)).toContain("an agent (role explore)");
    expect(nudgeText("edits", roles)).toContain("an agent (role developer or quick)");
    expect(nudgeText("checks", roles)).toContain("an agent (role runner)");
    expect(nudgeText("web", roles)).toContain("an agent (role web-research)");
  });

  test("names none it does not have, and never refuses", () => {
    for (const kind of ["reads", "edits", "checks", "web"] as const) {
      const text = nudgeText(kind, ["reviewer"]);
      expect(text).toStartWith("[dwa] ");
      expect(text).toContain("an agent");
      expect(text).toContain("spawn_agent");
      expect(text).not.toContain("role ");
      expect(text).toContain("a reminder, not a refusal");
    }
    expect(nudgeText("edits", ["quick"])).toContain("an agent (role quick)");
  });
});
