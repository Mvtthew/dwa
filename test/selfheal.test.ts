import { describe, expect, test } from "bun:test";
import { ConfigError } from "../src/shared/capabilities.ts";
import {
  bugReportText,
  type Change,
  describeChange,
  expandChanges,
  formatFile,
  keptChanges,
  maskSecrets,
  parseFile,
  sessionOnlyPossible,
  slug,
  textHunks,
  valuesAfter,
  warningOf,
  widens,
  withoutHunks,
} from "../src/shared/selfheal.ts";

const role = { kind: "role" as const, name: "developer" };

function changes(...inputs: Parameters<typeof expandChanges>[0]): Change[] {
  return expandChanges(inputs, role);
}

describe("the changes of a proposal", () => {
  test("each gets an id and the role under repair when it names no file", () => {
    const made = changes(
      { key: "allow", add: "Bash(git push *)", why: "to publish" },
      { key: "model", set: "opus", file: "defaults" },
      { key: "deny", remove: "WebFetch", file: "personal-role:mine" },
      { key: "effort", unset: true },
    );
    expect(made).toEqual([
      {
        id: "c1",
        file: role,
        why: "to publish",
        op: "add",
        key: "allow",
        item: "Bash(git push *)",
      },
      { id: "c2", file: { kind: "defaults" }, op: "set", key: "model", value: "opus" },
      {
        id: "c3",
        file: { kind: "role", name: "mine", source: "user" },
        op: "remove",
        key: "deny",
        item: "WebFetch",
      },
      { id: "c4", file: role, op: "unset", key: "effort" },
    ]);
  });

  test("what cannot be a change is refused with the reason", () => {
    expect(() => expandChanges([], role)).toThrow(ConfigError);
    expect(() => changes({ key: "allow" })).toThrow("exactly one of add, remove, set and unset");
    expect(() => changes({ key: "allow", add: "a", remove: "b" })).toThrow("exactly one");
    expect(() => changes({ key: "colour", set: "red" })).toThrow("unknown key");
    expect(() => changes({ key: "model", add: "opus" })).toThrow("use set");
    expect(() => changes({ key: "allow", set: "Bash" })).toThrow("use add or remove");
    expect(() => changes({ key: "memory", set: "yes" })).toThrow("true or false");
    expect(() => changes({ key: "prompt", set: "x", file: "defaults" })).toThrow(
      "[defaults] cannot hold prompt",
    );
    expect(() => changes({ key: "allow", add: "x", file: "somewhere" })).toThrow("not a file");
  });

  test("a file's short form reads back", () => {
    for (const text of ["defaults", "personal-defaults", "role:a", "personal-role:b"]) {
      expect(formatFile(parseFile(text))).toBe(text);
    }
  });
});

describe("values after the changes", () => {
  test("an item joins the list the layer has, and only changed keys come back", () => {
    const base = { allow: ["Bash(ls *)"], model: "sonnet" };
    expect(valuesAfter(base, changes({ key: "allow", add: "Bash(git log *)" }))).toEqual({
      allow: ["Bash(ls *)", "Bash(git log *)"],
    });
    expect(valuesAfter(base, changes({ key: "allow", add: "Bash(ls *)" }))).toEqual({});
    expect(valuesAfter(base, changes({ key: "model", unset: true }))).toEqual({ model: null });
  });

  test("a tool that is not in the default list writes the list out with it", () => {
    const after = valuesAfter({}, changes({ key: "tools", add: "WebSearch" }));
    expect(after.tools).toContain("Read");
    expect(after.tools).toContain("WebSearch");
  });

  test("a tool that was taken away is given back where it was taken", () => {
    expect(
      valuesAfter({ deny_tools: ["Bash", "Edit"] }, changes({ key: "tools", add: "Bash" })),
    ).toEqual({ deny_tools: ["Edit"] });
  });

  test("a tool list of its own gets the tool, and what was taken away is folded in", () => {
    expect(
      valuesAfter({ tools: ["Read", "Grep"] }, changes({ key: "tools", add: "Edit" })),
    ).toEqual({ tools: ["Read", "Grep", "Edit"] });
    const folded = valuesAfter(
      { deny_tools: ["Bash"] },
      changes({ key: "tools", add: "WebFetch" }),
    );
    expect(folded.deny_tools).toBeNull();
    expect(folded.tools).not.toContain("Bash");
    expect(folded.tools).toContain("WebFetch");
  });

  test("taking a tool away keeps the role's own way of saying it", () => {
    expect(
      valuesAfter({ tools: ["Read", "Edit"] }, changes({ key: "tools", remove: "Edit" })),
    ).toEqual({ tools: ["Read"] });
    expect(valuesAfter({}, changes({ key: "tools", remove: "Edit" }))).toEqual({
      deny_tools: ["Edit"],
    });
  });

  test("a first skills list starts from the project's skills", () => {
    expect(
      valuesAfter({}, changes({ key: "skills", add: "review-checklist" }), {
        projectSkills: ["deploy"],
      }),
    ).toEqual({ skills: ["deploy", "review-checklist"] });
  });
});

describe("what a change means for the user", () => {
  test("widening is told from narrowing", () => {
    const [add, takeBack, narrow, mode, memoryOff, prompt] = changes(
      { key: "allow", add: "Bash(rm *)" },
      { key: "deny_tools", remove: "Bash" },
      { key: "deny", add: "WebFetch" },
      { key: "permission_mode", set: "acceptEdits" },
      { key: "memory", set: false },
      { key: "prompt", set: "Be brief." },
    ) as [Change, Change, Change, Change, Change, Change];
    expect([add, takeBack, narrow, mode, memoryOff, prompt].map(widens)).toEqual([
      true,
      true,
      false,
      true,
      false,
      false,
    ]);
  });

  test("the far-reaching ones carry a warning", () => {
    const made = changes(
      { key: "permission_mode", set: "bypassPermissions" },
      { key: "permission_mode", set: "auto" },
      { key: "tools", add: "*" },
      { key: "memory", set: true },
      { key: "subagents", set: true },
      { key: "allow", add: "Bash(ls *)" },
    );
    expect(made.map((change) => warningOf(change) !== null)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  test("one line per change", () => {
    expect(
      changes(
        { key: "allow", add: "Bash(git push *)" },
        { key: "deny", remove: "WebFetch" },
        { key: "model", set: "opus" },
        { key: "prompt", set: "line one\nline two" },
        { key: "effort", unset: true },
      ).map(describeChange),
    ).toEqual([
      "allow + Bash(git push *)",
      "deny - WebFetch",
      'model = "opus"',
      "prompt rewritten (2 lines)",
      "effort removed",
    ]);
  });

  test("only capability values can be given to one session", () => {
    expect(sessionOnlyPossible(changes({ key: "allow", add: "x" }))).toBe(true);
    expect(
      sessionOnlyPossible(changes({ key: "allow", add: "x" }, { key: "prompt", set: "p" })),
    ).toBe(false);
  });
});

describe("texts that leave the daemon", () => {
  test("credentials are masked wherever they sit", () => {
    expect(
      maskSecrets({
        mcp: { github: { command: "gh-mcp", env: { TOKEN: "secret" }, headers: { A: "b" } } },
        list: [{ env: { X: "y" } }],
      }),
    ).toEqual({
      mcp: { github: { command: "gh-mcp", env: { TOKEN: "***" }, headers: { A: "***" } } },
      list: [{ env: { X: "***" } }],
    });
  });

  test("a report about dwa names what happened, the steps and who reported", () => {
    const text = bugReportText({
      title: "A granted skill is refused",
      what: "The skill is in the role and the hook refuses it.",
      steps: "1. Start a developer.\n2. Call the skill.",
      reports: [
        { reporter: "dev-1", role: "developer", what: "cannot use deploy", tried: "twice" },
      ],
      setup: "{}",
      version: "1.2.3",
      at: new Date("2026-11-27T10:00:00Z"),
    });
    expect(text).toStartWith("# A granted skill is refused\n");
    expect(text).toContain("on 2026-11-27, dwa 1.2.3");
    expect(text).toContain("## Steps to repeat\n\n1. Start a developer.");
    expect(text).toContain("- dev-1 (role developer): cannot use deploy\n  Tried: twice");
  });

  test("a title becomes a file name part", () => {
    expect(slug("A granted skill is REFUSED!")).toBe("a-granted-skill-is-refused");
    expect(slug("???")).toBe("report");
  });
});

describe("the parts of a changed text", () => {
  const before = "one\ntwo\nthree\nfour\n";
  const after = "ONE\ntwo\nthree\nfour\nfive\n";

  test("runs of lines that differ are found in order", () => {
    expect(textHunks(before, after)).toEqual([
      { index: 0, at: 0, remove: ["one"], add: ["ONE"] },
      { index: 1, at: 4, remove: [], add: ["five"] },
    ]);
    expect(textHunks(before, before)).toEqual([]);
  });

  test("leaving parts out gives the text with the rest", () => {
    expect(withoutHunks(before, after, [])).toBe(after);
    expect(withoutHunks(before, after, [0])).toBe("one\ntwo\nthree\nfour\nfive\n");
    expect(withoutHunks(before, after, [1])).toBe("ONE\ntwo\nthree\nfour\n");
    expect(withoutHunks(before, after, [0, 1])).toBe(before);
  });

  test("switched-off changes and parts are taken out of a proposal", () => {
    const all = changes({ key: "allow", add: "x" }, { key: "prompt", set: after });
    expect(keptChanges(all, ["c1"], before).map((change) => change.id)).toEqual(["c2"]);
    const [, prompt] = keptChanges(all, ["c2#0"], before);
    expect(prompt).toMatchObject({ key: "prompt", value: "one\ntwo\nthree\nfour\nfive\n" });
    // A prompt change with every part off is no change at all.
    expect(keptChanges(all, ["c2#0", "c2#1"], before).map((change) => change.id)).toEqual(["c1"]);
  });
});
