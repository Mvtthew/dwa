import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setKeys, TomlEditError, tomlValue } from "../src/shared/toml.ts";

const ROLES = join(import.meta.dir, "..", "examples", "roles");
const example = (name: string) => readFileSync(join(ROLES, `${name}.toml`), "utf8");
const parse = (text: string) => Bun.TOML.parse(text) as Record<string, unknown>;

/** The lines of `after` that are not in `before`, and the other way round. */
function changed(before: string, after: string): { gone: string[]; added: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  return {
    gone: a.filter((line) => !b.includes(line)),
    added: b.filter((line) => !a.includes(line)),
  };
}

describe("tomlValue", () => {
  test("writes short lists on one line and long ones item by item", () => {
    expect(tomlValue(["Read", "Grep"], "tools")).toBe('["Read", "Grep"]');
    const long = Array.from({ length: 8 }, (_, i) => `Bash(command number ${i} *)`);
    expect(tomlValue(long, "allow")).toBe(`[\n${long.map((v) => `  "${v}",\n`).join("")}]`);
    expect(tomlValue(true)).toBe("true");
    expect(tomlValue("a\nb")).toBe('"""\na\nb"""');
  });
});

describe("setKeys", () => {
  test("replaces one value and leaves every other line alone", () => {
    const before = example("explore");
    const after = setKeys(before, null, { model: "opus" });
    expect(changed(before, after)).toEqual({
      gone: ['model = "sonnet"'],
      added: ['model = "opus"'],
    });
    expect(parse(after).model).toBe("opus");
  });

  test("removes and appends items of a multi-line list, keeping the comments inside it", () => {
    const before = example("developer");
    const wanted = [
      "Bash(git status *)",
      "Bash(git log *)",
      "Bash(git show *)",
      "Bash(bun test *)",
    ];
    const after = setKeys(before, null, { allow: wanted });
    expect(parse(after).allow).toEqual(wanted);
    expect(changed(before, after)).toEqual({
      gone: ['  "Bash(git diff *)",'],
      added: ['  "Bash(bun test *)",'],
    });
    expect(after).toContain("# Add the project's own checks");
    // The new item comes right after the last real one, before the commented example.
    expect(after.indexOf('"Bash(bun test *)"')).toBeLessThan(after.indexOf("# Add the project"));
  });

  test("adds a comma to a last item that had none", () => {
    const before = 'allow = [\n  "a",\n  "b"\n]\n';
    expect(setKeys(before, null, { allow: ["a", "b", "c"] })).toBe(
      'allow = [\n  "a",\n  "b",\n  "c",\n]\n',
    );
    expect(setKeys(before, null, { allow: [] })).toBe("allow = [\n]\n");
    expect(setKeys(before, null, { allow: ["c"] })).toBe('allow = [\n  "c",\n]\n');
  });

  test("writes a list afresh when its order changes or it is on one line", () => {
    const before = example("explore");
    const after = setKeys(before, null, { tools: ["Read", "Bash"] });
    expect(changed(before, after)).toEqual({
      gone: ['tools = ["Read", "Grep", "Glob", "Bash"]'],
      added: ['tools = ["Read", "Bash"]'],
    });
    const reordered = setKeys('allow = [\n  "a", # first\n  "b",\n]\n', null, {
      allow: ["b", "a"],
    });
    expect(parse(reordered).allow).toEqual(["b", "a"]);
  });

  test("puts new keys after the last setting and before the prompt", () => {
    const before = example("reviewer");
    const after = setKeys(before, null, { deny: ["Bash(rm *)"], memory: true }, ["prompt"]);
    expect(changed(before, after)).toEqual({
      gone: [],
      added: ['deny = ["Bash(rm *)"]', "memory = true"],
    });
    expect(after.indexOf("memory = true")).toBeLessThan(after.indexOf('prompt = """'));
    expect(after.indexOf('skills = ["review-checklist"]')).toBeLessThan(after.indexOf("deny ="));
    expect(parse(after).prompt).toBe(parse(before).prompt);
  });

  test("removes a key with its line, and a multi-line value with all its lines", () => {
    const before = example("developer");
    const after = setKeys(before, null, { allow: undefined, permission_mode: undefined });
    const parsed = parse(after);
    expect(parsed.allow).toBeUndefined();
    expect(parsed.permission_mode).toBeUndefined();
    expect(parsed.deny).toEqual(["Bash(git push *)"]);
    expect(after).toContain("# Publishing is the user's step.");
  });

  test("replaces a multi-line prompt and keeps a comment after a value", () => {
    const before = 'model = "opus" # the strong one\nprompt = """\nold "quoted"\ntext\n"""\n';
    const after = setKeys(before, null, { prompt: "new\ntext\n", model: "sonnet" });
    expect(after).toBe('model = "sonnet" # the strong one\nprompt = """\nnew\ntext\n"""\n');
  });

  test("changes keys of a table without touching the root or other tables", () => {
    const before = '# top\n[main]\nmodel = "opus"\n\n[defaults]\nmodel = "sonnet"\n# tail\n';
    const after = setKeys(before, "defaults", { model: "haiku", deny_tools: ["WebFetch"] });
    expect(after).toBe(
      '# top\n[main]\nmodel = "opus"\n\n[defaults]\nmodel = "haiku"\ndeny_tools = ["WebFetch"]\n# tail\n',
    );
    expect(setKeys('a = 1\n\n[main]\nmodel = "opus"\n', "defaults", { memory: true })).toBe(
      'a = 1\n\n[main]\nmodel = "opus"\n\n[defaults]\nmemory = true\n',
    );
    expect(setKeys("[defaults]\n", "defaults", { memory: true })).toBe(
      "[defaults]\nmemory = true\n",
    );
  });

  test("puts a new root key before the first table, and into an empty file", () => {
    expect(setKeys('# only a comment\n[main]\nrole = "main"\n', null, { x: "y" })).toBe(
      '# only a comment\nx = "y"\n\n[main]\nrole = "main"\n',
    );
    expect(setKeys("", null, { description: "new" })).toBe('description = "new"\n');
    expect(setKeys("# note", null, { description: "new" })).toBe('# note\ndescription = "new"\n');
  });

  test("survives every example role: any single key can be set and removed again", () => {
    for (const file of readdirSync(ROLES)) {
      const before = readFileSync(join(ROLES, file), "utf8");
      for (const key of Object.keys(parse(before))) {
        const removed = setKeys(before, null, { [key]: undefined });
        expect(parse(removed)[key]).toBeUndefined();
      }
      const withKey = setKeys(before, null, { off_skills: ["x"] }, ["prompt"]);
      expect(setKeys(withKey, null, { off_skills: undefined })).toBe(before);
    }
  });

  test("refuses a file it cannot read safely instead of writing it", () => {
    expect(() => setKeys('a = "1"\na = "2"\n', null, { a: "3" })).toThrow();
    expect(() => setKeys("[a.b]\nc = 1\n", "a.b", { c: 2 })).toThrow(TomlEditError);
  });
});
