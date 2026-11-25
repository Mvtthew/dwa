import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BY_HAND,
  diffLines,
  moveHistory,
  readHistory,
  record,
  saveTracked,
  switchTo,
  type Tracked,
  versionText,
} from "../src/shared/history.ts";

let dir: string;
let tracked: Tracked;
const at = (minute: number) => new Date(Date.UTC(2026, 10, 25, 12, minute));
const numbers = () => readHistory(tracked).versions.map((version) => [version.n, version.source]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dwa-history-"));
  tracked = { path: join(dir, "roles", "reviewer.toml"), dir: join(dir, "history", "reviewer") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("history", () => {
  test("a missing file has no history and recording it does nothing", () => {
    expect(record(tracked, BY_HAND)).toBeNull();
    expect(readHistory(tracked)).toEqual({ current: null, versions: [] });
  });

  test("numbers versions, notices edits made by hand and skips unchanged content", () => {
    saveTracked(tracked, 'model = "opus"\n', "role settings", at(0));
    expect(numbers()).toEqual([[1, "role settings"]]);
    expect(record(tracked, BY_HAND, at(1))?.n).toBe(1);

    writeFileSync(tracked.path, 'model = "sonnet"\n');
    saveTracked(tracked, 'model = "haiku"\n', "tools dialog", at(2));
    expect(numbers()).toEqual([
      [1, "role settings"],
      [2, BY_HAND],
      [3, "tools dialog"],
    ]);
    expect(readHistory(tracked).current).toBe(3);
    expect(versionText(tracked, 2)).toBe('model = "sonnet"\n');
    expect(readHistory(tracked).versions[2]?.time).toBe(at(2).toISOString());
  });

  test("the first look at a file written by hand is the first version", () => {
    saveTracked(tracked, "a = 1\n", "x");
    rmSync(tracked.dir, { recursive: true });
    record(tracked, BY_HAND);
    expect(numbers()).toEqual([[1, "first version"]]);
  });

  test("switching moves the pointer, keeps every version, and an edit after it is the next number", () => {
    for (const n of [1, 2, 3, 4]) saveTracked(tracked, `v = ${n}\n`, "role settings", at(n));
    switchTo(tracked, 2);
    expect(readFileSync(tracked.path, "utf8")).toBe("v = 2\n");
    expect(readHistory(tracked).current).toBe(2);
    expect(numbers()).toHaveLength(4);

    switchTo(tracked, 4);
    expect(readFileSync(tracked.path, "utf8")).toBe("v = 4\n");
    switchTo(tracked, 2);
    saveTracked(tracked, "v = 22\n", "role settings", at(9));
    expect(readHistory(tracked).current).toBe(5);
    expect(versionText(tracked, 4)).toBe("v = 4\n");
    expect(() => switchTo(tracked, 9)).toThrow("no version v9");
  });

  test("an unrecorded edit is kept as a version before a switch overwrites it", () => {
    saveTracked(tracked, "v = 1\n", "role settings");
    saveTracked(tracked, "v = 2\n", "role settings");
    writeFileSync(tracked.path, "v = 3 # by hand\n");
    switchTo(tracked, 1);
    expect(numbers().at(-1)).toEqual([3, BY_HAND]);
    expect(versionText(tracked, 3)).toBe("v = 3 # by hand\n");
    expect(readHistory(tracked).current).toBe(1);
  });

  test("content typed back by hand moves the pointer instead of adding a version", () => {
    saveTracked(tracked, "v = 1\n", "role settings");
    saveTracked(tracked, "v = 2\n", "role settings");
    writeFileSync(tracked.path, "v = 1\n");
    expect(record(tracked, BY_HAND)?.n).toBe(1);
    expect(numbers()).toHaveLength(2);
  });

  test("a damaged index does not make dwa write over the versions that are there", () => {
    saveTracked(tracked, "v = 1\n", "role settings");
    saveTracked(tracked, "v = 2\n", "role settings");
    writeFileSync(join(tracked.dir, "index.json"), "{ not json");
    expect(readHistory(tracked).versions.map((v) => [v.n, v.source])).toEqual([
      [1, "recovered"],
      [2, "recovered"],
    ]);
    // The file's content is known: the pointer finds it again and nothing new is written.
    expect(record(tracked, BY_HAND)?.n).toBe(2);
    saveTracked(tracked, "v = 3\n", "role settings");
    expect(versionText(tracked, 1)).toBe("v = 1\n");
    expect(readHistory(tracked).current).toBe(3);
  });

  test("moves with a renamed file", () => {
    saveTracked(tracked, "v = 1\n", "role settings");
    const renamed = {
      path: join(dir, "roles", "critic.toml"),
      dir: join(dir, "history", "critic"),
    };
    moveHistory(tracked, renamed);
    expect(existsSync(tracked.dir)).toBe(false);
    expect(versionText(renamed, 1)).toBe("v = 1\n");
  });
});

describe("diffLines", () => {
  test("marks removed and added lines with context and gaps", () => {
    const a = ["one", "two", "three", "four", "five", "six", "seven", "eight"].join("\n");
    const b = a.replace("two", "2").replace("eight", "8\nnine");
    expect(diffLines(a, b, 1)).toEqual([
      "  one",
      "- two",
      "+ 2",
      "  three",
      "  ...",
      "  seven",
      "- eight",
      "+ 8",
      "+ nine",
    ]);
    expect(diffLines(a, a)).toEqual([]);
  });
});
