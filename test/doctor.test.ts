import { describe, expect, test } from "bun:test";
import { type RunCommand, runChecks } from "../src/cli/doctor.ts";

function fakeRun(outputs: Record<string, string | null>): RunCommand {
  return async (argv) => outputs[argv[0] ?? ""] ?? null;
}

describe("runChecks", () => {
  test("passes when everything is new enough", async () => {
    const results = await runChecks({
      bunVersion: "1.4.3",
      claudeCommands: ["claude"],
      run: fakeRun({ tmux: "tmux 3.8", claude: "2.1.331 (Claude Code)" }),
    });
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
  });

  test("reports a missing tmux and an old Claude Code", async () => {
    const results = await runChecks({
      bunVersion: "1.4.3",
      claudeCommands: ["claude"],
      run: fakeRun({ tmux: null, claude: "2.1.100 (Claude Code)" }),
    });
    const [bun, tmux, claude] = results;
    expect(bun?.ok).toBe(true);
    expect(tmux?.ok).toBe(false);
    expect(tmux?.detail).toContain("not found");
    expect(claude?.ok).toBe(false);
    expect(claude?.detail).toContain("2.1.224");
  });

  test("checks every configured Claude command", async () => {
    const results = await runChecks({
      bunVersion: "1.4.3",
      claudeCommands: ["/bin/claude_me", "/bin/claude_work"],
      run: fakeRun({
        tmux: "tmux 3.8",
        "/bin/claude_me": "2.1.331 (Claude Code)",
        "/bin/claude_work": null,
      }),
    });
    expect(results.map((r) => r.name)).toEqual([
      "bun",
      "tmux",
      "claude (/bin/claude_me)",
      "claude (/bin/claude_work)",
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
  });

  test("rejects an old Bun", async () => {
    const [bun] = await runChecks({
      bunVersion: "1.2.0",
      claudeCommands: [],
      run: fakeRun({ tmux: "tmux 3.8" }),
    });
    expect(bun?.ok).toBe(false);
  });
});
