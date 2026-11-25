import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addTable,
  moveTable,
  removeTable,
  renameTable,
  replaceInValue,
  setKeys,
  TomlEditError,
  tableOrder,
  tomlValue,
} from "../src/shared/toml.ts";

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
    expect(() => setKeys("[[a]]\nc = 1\n", "a", { c: 2 })).toThrow(TomlEditError);
  });
});

// A workflow-like text in pieces, so a result can be compared byte for byte with the pieces
// that must not have changed.
const HEAD = '# Top comment\n# second line\ndescription = "d"\n\n';
const A = '# about a\n[steps.a]\nrole = "x"\nprompt = """\ndo a\n"""\n';
const BUILD =
  '# about build\n[steps.build]\nrole = "developer" # who\ndepends_on = ["a"]\n' +
  'allow = [\n  "one", # first\n  # between\n  "two",\n]\n' +
  'prompt = """\nbuild {{steps.a.result}}\n"""\n';
const LOOSE = "# loose comment\n";
const C = "# about c\n[steps.c]\ndepends_on = [\"build\"]\nprompt = 'c'\n";
const TEXT = `${HEAD}${A}\n${BUILD}\n${LOOSE}\n${C}`;
const D = '[steps.d]\nrole = "r"\nprompt = "p"\n';

/** `text` with one piece replaced; the piece has to be there exactly once. */
function swap(text: string, from: string, to: string): string {
  expect(text.split(from)).toHaveLength(2);
  return text.replace(from, () => to);
}

describe("setKeys on a nested table", () => {
  test("sets a value and keeps the comment after it and every other byte", () => {
    const after = setKeys(TEXT, "steps.build", { role: "tester" });
    expect(after).toBe(swap(TEXT, 'role = "developer" # who', 'role = "tester" # who'));
    expect(after).toStartWith(`${HEAD}${A}\n`);
    expect(after).toEndWith(`\n${LOOSE}\n${C}`);
    expect((parse(after).steps as Record<string, { role?: string }>).a?.role).toBe("x");
  });

  test("adds keys after the last setting and keeps the prompt last", () => {
    const after = setKeys(TEXT, "steps.build", { model: "opus", keep_agent: true }, ["prompt"]);
    expect(after).toBe(
      swap(
        TEXT,
        ']\nprompt = """\nbuild',
        ']\nmodel = "opus"\nkeep_agent = true\nprompt = """\nbuild',
      ),
    );
    expect(after).toStartWith(`${HEAD}${A}\n`);
    expect(after).toEndWith(`\n${LOOSE}\n${C}`);
    const build = (parse(after).steps as Record<string, Record<string, unknown>>).build;
    expect(Object.keys(build ?? {}).at(-1)).toBe("prompt");
    expect(build).toMatchObject({ model: "opus", keep_agent: true });
  });

  test("removes a key with its line", () => {
    const after = setKeys(TEXT, "steps.build", { depends_on: undefined });
    expect(after).toBe(swap(TEXT, 'depends_on = ["a"]\n', ""));
    // The key of the same name in another step is not this one's.
    expect(after).toEndWith(C);
    expect(setKeys(TEXT, "steps.c", { depends_on: undefined })).toBe(
      swap(TEXT, 'depends_on = ["build"]\n', ""),
    );
  });

  test("edits a multi-line list item by item, keeping the comments inside it", () => {
    const after = setKeys(TEXT, "steps.build", { allow: ["one", "three"] });
    expect(after).toBe(swap(TEXT, '  # between\n  "two",\n', '  "three",\n  # between\n'));
    expect(after).toContain('  "one", # first\n');
    expect(after).toStartWith(`${HEAD}${A}\n`);
    expect(after).toEndWith(`\n${LOOSE}\n${C}`);
    const steps = parse(after).steps as Record<string, { allow?: string[] }>;
    expect(steps.build?.allow).toEqual(["one", "three"]);
  });

  test("adds the header of a nested table that does not exist yet", () => {
    expect(setKeys(TEXT, "steps.d", { prompt: "d" })).toBe(`${TEXT}\n[steps.d]\nprompt = "d"\n`);
    expect(setKeys('description = "x"\n', "steps.d", { prompt: "d" })).toBe(
      'description = "x"\n\n[steps.d]\nprompt = "d"\n',
    );
    expect(setKeys("", "steps.d", { prompt: "d" })).toBe('[steps.d]\nprompt = "d"\n');
    // Removing a key of a table that is not there writes nothing, the header included.
    expect(setKeys(TEXT, "steps.d", { prompt: undefined })).toBe(TEXT);
  });

  test("is refused for a list of tables", () => {
    const text = '[[steps.a]]\nc = 1\n\n[[agents]]\nname = "x"\n';
    expect(() => setKeys(text, "steps.a", { c: 2 })).toThrow(TomlEditError);
    expect(() => setKeys(text, "steps.a", { c: 2 })).toThrow("list of tables");
    expect(() => setKeys(text, "agents", { name: "y" })).toThrow(TomlEditError);
  });
});

describe("addTable", () => {
  test("adds a table at the end, with the keys named in last at its end", () => {
    const after = addTable(TEXT, "steps.d", { prompt: "p", role: "r" }, { last: ["prompt"] });
    expect(after).toBe(`${TEXT}\n${D}`);
    expect(tableOrder(after, "steps")).toEqual(["a", "build", "c", "d"]);
    // Without `last` the keys are written in the order given.
    expect(addTable(TEXT, "steps.d", { prompt: "p", role: "r" })).toBe(
      `${TEXT}\n[steps.d]\nprompt = "p"\nrole = "r"\n`,
    );
  });

  test("adds a table before another, above that table's comment", () => {
    const options = { before: "steps.build", last: ["prompt"] };
    expect(addTable(TEXT, "steps.d", { prompt: "p", role: "r" }, options)).toBe(
      `${HEAD}${A}\n${D}\n${BUILD}\n${LOOSE}\n${C}`,
    );
    // A comment separated by an empty line is not the next table's: the new one goes under it.
    expect(addTable(TEXT, "steps.d", { role: "r", prompt: "p" }, { before: "steps.c" })).toBe(
      `${HEAD}${A}\n${BUILD}\n${LOOSE}\n${D}\n${C}`,
    );
    expect(addTable(TEXT, "steps.d", { role: "r", prompt: "p" }, { before: "steps.a" })).toBe(
      `${HEAD}${D}\n${A}\n${BUILD}\n${LOOSE}\n${C}`,
    );
  });

  test("adds a table to an empty text, to one without a last newline, and before other tables", () => {
    expect(addTable("", "steps.d", { prompt: "p", role: "r" }, { last: ["prompt"] })).toBe(D);
    expect(addTable('[steps.a]\nprompt = "a"', "steps.b", { prompt: "p" })).toBe(
      '[steps.a]\nprompt = "a"\n\n[steps.b]\nprompt = "p"\n',
    );
    // After the last table next to it, not at the end of the file.
    expect(
      addTable('[steps.a]\nprompt = "a"\n\n[other]\nx = 1\n', "steps.b", { prompt: "p" }),
    ).toBe('[steps.a]\nprompt = "a"\n\n[steps.b]\nprompt = "p"\n\n[other]\nx = 1\n');
  });

  test("is refused when the table exists or the one to go before does not", () => {
    expect(() => addTable(TEXT, "steps.a", { prompt: "p" })).toThrow(TomlEditError);
    expect(() => addTable(TEXT, "steps.a", { prompt: "p" })).toThrow("already a table [steps.a]");
    expect(() => addTable(TEXT, "steps.d", { prompt: "p" }, { before: "steps.zz" })).toThrow(
      "no table [steps.zz]",
    );
  });
});

describe("removeTable", () => {
  test("takes the comment lines directly above the table with it", () => {
    const after = removeTable(TEXT, "steps.a");
    expect(after).toBe(`${HEAD}${BUILD}\n${LOOSE}\n${C}`);
    expect(after).not.toContain("# about a");
  });

  test("leaves a comment an empty line separates from the table, and no empty lines at the end", () => {
    expect(removeTable(TEXT, "steps.c")).toBe(`${HEAD}${A}\n${BUILD}\n${LOOSE}`);
    expect(removeTable('# c\n\n[steps.a]\nprompt = "a"\n', "steps.a")).toBe("# c\n");
    expect(removeTable(`${HEAD}${A}`, "steps.a")).toBe(
      '# Top comment\n# second line\ndescription = "d"\n',
    );
  });

  test("removes a table in the middle and leaves the tables around it as they are", () => {
    const after = removeTable(TEXT, "steps.build");
    expect(after).toStartWith(`${HEAD}${A}\n`);
    expect(after).toEndWith(`\n${C}`);
    expect(after).not.toContain("# about build");
    expect(tableOrder(after, "steps")).toEqual(["a", "c"]);
  });

  test("is refused for a missing table and for one with tables inside", () => {
    expect(() => removeTable(TEXT, "steps.zz")).toThrow(TomlEditError);
    expect(() => removeTable(TEXT, "steps.zz")).toThrow("no table [steps.zz]");
    const nested = '[steps]\n[steps.a]\nprompt = "a"\n';
    expect(() => removeTable(nested, "steps")).toThrow(TomlEditError);
    expect(() => removeTable(nested, "steps")).toThrow("has tables inside it");
    expect(() => removeTable("[[steps.a]]\nc = 1\n", "steps.a")).toThrow(TomlEditError);
  });
});

describe("renameTable", () => {
  const QUOTED =
    '# head\n[ steps . "a" ]\nprompt = "a"\n\n' +
    "[steps.'b c']\nprompt = \"b\"\n\n" +
    '[steps.d] # trailing\nprompt = "d"\n';

  test("changes only the name in the header, however it is written", () => {
    expect(renameTable(QUOTED, "steps.a", "steps.z")).toBe(
      swap(QUOTED, '[ steps . "a" ]', "[ steps.z ]"),
    );
    expect(renameTable(QUOTED, "steps.b c", "steps.b")).toBe(
      swap(QUOTED, "[steps.'b c']", "[steps.b]"),
    );
    // A name that is not a bare key is quoted; the comment after the header stays.
    const spaced = renameTable(QUOTED, "steps.d", "steps.e f");
    expect(spaced).toBe(swap(QUOTED, "[steps.d] # trailing", '[steps."e f"] # trailing'));
    expect(tableOrder(spaced, "steps")).toEqual(["a", "b c", "e f"]);
    expect(renameTable(TEXT, "steps.build", "steps.make")).toBe(
      swap(TEXT, "[steps.build]", "[steps.make]"),
    );
  });

  test("is refused when the new name exists, the table is missing or the parent differs", () => {
    expect(() => renameTable(QUOTED, "steps.a", "steps.d")).toThrow(TomlEditError);
    expect(() => renameTable(QUOTED, "steps.a", "steps.d")).toThrow("already a table [steps.d]");
    expect(() => renameTable(QUOTED, "steps.q", "steps.r")).toThrow("no table [steps.q]");
    expect(() => renameTable(QUOTED, "steps.a", "other.a")).toThrow(TomlEditError);
  });
});

describe("moveTable", () => {
  test("moves a table to the front with its comment", () => {
    const after = moveTable(TEXT, "steps.c", "steps.a");
    expect(after).toBe(`${HEAD}${C}\n${A}\n${BUILD}\n${LOOSE}`);
    expect(parse(after)).toEqual(parse(TEXT));
  });

  test("moves a table to the end with null", () => {
    const after = moveTable(TEXT, "steps.a", null);
    expect(after).toBe(`${HEAD}${BUILD}\n${LOOSE}\n${C}\n${A}`);
    expect(tableOrder(after, "steps")).toEqual(["build", "c", "a"]);
    expect(parse(after)).toEqual(parse(TEXT));
  });

  test("changes nothing when the table is already there", () => {
    expect(moveTable(TEXT, "steps.a", "steps.a")).toBe(TEXT);
    expect(moveTable(TEXT, "steps.a", "steps.build")).toBe(TEXT);
    expect(moveTable(TEXT, "steps.c", null)).toBe(TEXT);
  });

  test("is refused for a table that is not there", () => {
    expect(() => moveTable(TEXT, "steps.zz", null)).toThrow(TomlEditError);
    expect(() => moveTable(TEXT, "steps.a", "steps.zz")).toThrow(TomlEditError);
  });

  test("a file without a last newline stays without one", () => {
    const a = '# ca\n[steps.a]\nprompt = "a"';
    const b = '# cb\n[steps.b]\nprompt = "b"';
    const text = `# h\n\n${a}\n\n${b}`;
    expect(moveTable(text, "steps.b", "steps.a")).toBe(`# h\n\n${b}\n\n${a}`);
    expect(moveTable(text, "steps.a", null)).toBe(`# h\n\n${b}\n\n${a}`);
  });

  const CRLF =
    '# h\r\ndescription = "d"\r\n\r\n# ca\r\n[steps.a]\r\nprompt = "a"\r\n\r\n' +
    '# cb\r\n[steps.b]\r\nprompt = "b"\r\n';

  test("a file with CRLF line ends still parses and keeps its content", () => {
    const lines = (value: string) =>
      value
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter((line) => line !== "")
        .sort();
    for (const after of [moveTable(CRLF, "steps.b", "steps.a"), moveTable(CRLF, "steps.a", null)]) {
      expect(parse(after)).toEqual(parse(CRLF));
      expect(tableOrder(after, "steps")).toEqual(["b", "a"]);
      expect(lines(after)).toEqual(lines(CRLF));
      expect(after).toStartWith('# h\r\ndescription = "d"\r\n');
      // Each comment is still right above its table.
      expect(after).toContain("# cb\r\n[steps.b]\r\n");
      expect(after).toContain("# ca\r\n[steps.a]\r\n");
    }
  });

  // Today the moved block is joined with "\n" and, before a table, one empty line too many.
  test("a CRLF file keeps its line ends and gets no extra empty line when a table moves", () => {
    const a = '# ca\r\n[steps.a]\r\nprompt = "a"\r\n';
    const b = '# cb\r\n[steps.b]\r\nprompt = "b"\r\n';
    expect(moveTable(CRLF, "steps.b", "steps.a")).toBe(
      `# h\r\ndescription = "d"\r\n\r\n${b}\r\n${a}`,
    );
  });
});

describe("tableOrder", () => {
  test("names the tables directly under a parent in the order they are written", () => {
    expect(tableOrder(TEXT, "steps")).toEqual(["a", "build", "c"]);
    expect(tableOrder(TEXT, "")).toEqual([]);
    expect(tableOrder(TEXT, "other")).toEqual([]);
    const mixed = "[a]\n[b.c]\n[[d]]\n[b.e]\n";
    expect(tableOrder(mixed, "")).toEqual(["a", "d"]);
    expect(tableOrder(mixed, "b")).toEqual(["c", "e"]);
    expect(tableOrder("[ steps . \"a\" ]\n[steps.'b c']\n", "steps")).toEqual(["a", "b c"]);
  });
});

describe("replaceInValue", () => {
  const RAW =
    '[steps.a]\nprompt = "use {{steps.x.result}} \\"q\\"" # why\n\n' +
    '[steps.b]\nprompt = """\nline {{steps.x.result}}\n  indented\n"""\n\n' +
    "[steps.c]\nprompt = '''\nraw \\d {{steps.x.result}}\n'''\nother = '{{steps.x.result}}'\n";
  const rename = (raw: string) => raw.replaceAll("steps.x.", "steps.y.");

  test("changes a basic string as it is written", () => {
    expect(replaceInValue(RAW, "steps.a", "prompt", rename)).toBe(
      swap(RAW, '"use {{steps.x.result}} \\"q\\""', '"use {{steps.y.result}} \\"q\\""'),
    );
  });

  test("a multi-line basic string and a literal one keep their form", () => {
    const b = replaceInValue(RAW, "steps.b", "prompt", rename);
    expect(b).toBe(swap(RAW, "line {{steps.x.result}}", "line {{steps.y.result}}"));
    const c = replaceInValue(RAW, "steps.c", "prompt", rename);
    expect(c).toBe(swap(RAW, "raw \\d {{steps.x.result}}", "raw \\d {{steps.y.result}}"));
    const steps = parse(c).steps as Record<string, Record<string, string>>;
    expect(steps.c?.prompt).toBe("raw \\d {{steps.y.result}}\n");
    // Another key of the same table is not touched.
    expect(steps.c?.other).toBe("{{steps.x.result}}");
  });

  test("gives the raw text of the value, quotes included, and nothing else", () => {
    const seen: string[] = [];
    replaceInValue(RAW, "steps.a", "prompt", (raw) => {
      seen.push(raw);
      return raw;
    });
    expect(seen).toEqual(['"use {{steps.x.result}} \\"q\\""']);
  });

  test("returns the text itself when nothing changes, and refuses a result that does not parse", () => {
    expect(replaceInValue(RAW, "steps.c", "missing", rename)).toBe(RAW);
    expect(replaceInValue(RAW, "steps.zz", "prompt", rename)).toBe(RAW);
    expect(replaceInValue(RAW, "steps.c", "prompt", (raw) => raw)).toBe(RAW);
    expect(() => replaceInValue(RAW, "steps.a", "prompt", () => '"open')).toThrow(TomlEditError);
  });
});
