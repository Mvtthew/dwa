import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localVerdict } from "../src/cli/hook.ts";

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
