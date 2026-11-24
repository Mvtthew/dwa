import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandPath, userConfigPath } from "../src/shared/paths.ts";
import { compareVersions, parseVersion, satisfiesMinimum } from "../src/shared/version.ts";

describe("parseVersion", () => {
  test("reads real version output", () => {
    expect(parseVersion("tmux 3.8")).toEqual([3, 8]);
    expect(parseVersion("tmux next-3.9")).toEqual([3, 9]);
    expect(parseVersion("tmux 3.5a")).toEqual([3, 5]);
    expect(parseVersion("2.1.331 (Claude Code)")).toEqual([2, 1, 331]);
  });

  test("returns null without a number", () => {
    expect(parseVersion("command not found")).toBeNull();
  });
});

describe("compareVersions", () => {
  test("compares numerically, not as text", () => {
    expect(compareVersions([2, 1, 331], [2, 1, 224])).toBeGreaterThan(0);
    expect(compareVersions([3, 10], [3, 7])).toBeGreaterThan(0);
    expect(compareVersions([3, 6], [3, 7])).toBeLessThan(0);
  });

  test("treats missing parts as zero", () => {
    expect(compareVersions([3, 7], [3, 7, 0])).toBe(0);
    expect(compareVersions([3], [3, 7])).toBeLessThan(0);
  });
});

describe("satisfiesMinimum", () => {
  test("accepts equal and newer, rejects older and unreadable", () => {
    expect(satisfiesMinimum("tmux 3.7", "3.7")).toBe(true);
    expect(satisfiesMinimum("tmux 3.8", "3.7")).toBe(true);
    expect(satisfiesMinimum("tmux 3.6a", "3.7")).toBe(false);
    expect(satisfiesMinimum("", "3.7")).toBe(false);
  });
});

describe("expandPath", () => {
  test("expands a leading tilde only", () => {
    expect(expandPath("~/claude_me")).toBe(join(homedir(), "claude_me"));
    expect(expandPath("~")).toBe(homedir());
    expect(expandPath("/opt/a~b")).toBe("/opt/a~b");
    expect(expandPath("claude")).toBe("claude");
  });

  test("expands environment variables", () => {
    const env = { TOOLS: "/opt/tools" };
    expect(expandPath("$TOOLS/claude_work", env)).toBe("/opt/tools/claude_work");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal shell syntax is what is tested
    expect(expandPath("${TOOLS}/claude_work", env)).toBe("/opt/tools/claude_work");
    expect(expandPath("$MISSING/claude", env)).toBe("/claude");
  });
});

describe("userConfigPath", () => {
  test("honours XDG_CONFIG_HOME and falls back to ~/.config", () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/dwa/config.toml");
    expect(userConfigPath({})).toBe(join(homedir(), ".config", "dwa", "config.toml"));
  });
});
