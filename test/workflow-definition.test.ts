import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/shared/config.ts";
import type { WorkflowRunInfo } from "../src/shared/protocol.ts";
import type { ScopeContext } from "../src/shared/scope.ts";
import {
  checkWorkflow,
  dependents,
  describeRun,
  findWorkflow,
  formatWorkflow,
  listAllWorkflows,
  listWorkflows,
  loadWorkflow,
  parseWorkflow,
  readySteps,
  renderPrompt,
  reworkSteps,
  sameWork,
  summarizeWorkflow,
  WorkflowError,
  workflowKind,
} from "../src/shared/workflow.ts";

const FEATURE = `
description = "Explore, build, review"

[steps.explore]
role = "explore"
prompt = "Map the code for: {{input}}"

[steps.build]
role = "developer"
depends_on = ["explore"]
prompt = "Implement {{ input }}. Findings:\\n{{steps.explore.result}}"

[steps.review]
depends_on = ["build"]
keep_agent = true
prompt = "Review. Explorer said: {{steps.explore.result}}"
`;

/** Texts that are not a workflow, and what the error says. */
const invalid: [string, string, RegExp][] = [
  ["broken TOML", "[steps", /invalid TOML/],
  ["no steps", 'description = "x"', /needs at least one step/],
  ["an empty step table", "[steps]", /at least one step/],
  ["an unknown key", '[steps.a]\nprompt = "x"\nrole_name = "y"', /role_name|Unrecognized/],
  ["a step without a prompt", '[steps.a]\nrole = "x"', /prompt/],
  ["an unknown dependency", '[steps.a]\nprompt = "x"\ndepends_on = ["b"]', /unknown step "b"/],
  ["a bad step name", '[steps."a b"]\nprompt = "x"', /step name "a b"/],
  [
    "a cycle",
    '[steps.a]\nprompt = "x"\ndepends_on = ["b"]\n[steps.b]\nprompt = "y"\ndepends_on = ["a"]',
    /cycle \(a -> b -> a\)/,
  ],
  ["a step that depends on itself", '[steps.a]\nprompt = "x"\ndepends_on = ["a"]', /cycle/],
  ["an unknown placeholder", '[steps.a]\nprompt = "{{inptu}}"', /unknown placeholder/],
  [
    "a result of a step it does not depend on",
    '[steps.a]\nprompt = "x"\n[steps.b]\nprompt = "{{steps.a.result}}"',
    /does not depend on it/,
  ],
];

describe("parseWorkflow", () => {
  test("reads steps in file order with defaults", () => {
    const workflow = parseWorkflow(FEATURE, "feature");
    expect(workflow.name).toBe("feature");
    expect(workflow.description).toBe("Explore, build, review");
    expect(Object.keys(workflow.steps)).toEqual(["explore", "build", "review"]);
    expect(workflow.steps.explore).toEqual({
      role: "explore",
      prompt: "Map the code for: {{input}}",
      depends_on: [],
      keep_agent: false,
    });
    expect(workflow.steps.review?.keep_agent).toBe(true);
  });

  for (const [what, text, message] of invalid) {
    test(`rejects ${what}`, () => {
      expect(() => parseWorkflow(text, "w")).toThrow(ConfigError);
      expect(() => parseWorkflow(text, "w")).toThrow(message);
    });
  }
});

describe("checkWorkflow", () => {
  /** Where each problem of the table above is reported, and whether the text has the wrong shape. */
  const where: Record<string, { step?: string; key?: string; shape?: boolean }> = {
    "broken TOML": { shape: true },
    "no steps": { shape: true },
    "an empty step table": {},
    "an unknown key": { step: "a", shape: true },
    "a step without a prompt": { step: "a", key: "prompt", shape: true },
    "an unknown dependency": { step: "a", key: "depends_on" },
    "a bad step name": { step: "a b" },
    "a cycle": {},
    "a step that depends on itself": {},
    "an unknown placeholder": { step: "a", key: "prompt" },
    "a result of a step it does not depend on": { step: "b", key: "prompt" },
  };

  test("the table of places covers every kind of error", () => {
    expect(Object.keys(where).sort()).toEqual(invalid.map(([what]) => what).sort());
  });

  for (const [what, text, message] of invalid) {
    test(`says where ${what} is`, () => {
      const { step, key, shape = false } = where[what] ?? {};
      const check = checkWorkflow(text, "w");
      expect(check.definition).toBeNull();
      expect(check.shape).toBe(shape);
      expect(check.problems).toHaveLength(1);
      const [problem] = check.problems;
      expect(problem?.message).toMatch(message);
      expect(problem?.step).toBe(step);
      expect(problem?.key).toBe(key);
      // The message is the one parseWorkflow throws, after the source.
      expect(() => parseWorkflow(text, "w", "file.toml")).toThrow(`file.toml: ${problem?.message}`);
    });
  }

  test("says where the other schema errors and the review errors are", () => {
    const one = (text: string) => {
      const check = checkWorkflow(text, "w");
      expect(check.problems).toHaveLength(1);
      const [problem] = check.problems;
      return { step: problem?.step, key: problem?.key, shape: check.shape };
    };
    expect(one('[steps.a]\nprompt = ""')).toEqual({ step: "a", key: "prompt", shape: true });
    expect(one('[steps.a]\nprompt = "x"\ntools = ["Read"]\ndeny_tools = ["Edit"]')).toEqual({
      step: "a",
      key: "deny_tools",
      shape: true,
    });
    expect(one('[steps.a]\nprompt = "x"\npermission_mode = "yolo"')).toEqual({
      step: "a",
      key: "permission_mode",
      shape: true,
    });
    expect(one('[steps.a]\nprompt = "a"\nreviews = "nope"')).toEqual({
      step: "a",
      key: "reviews",
      shape: false,
    });
    expect(one('[steps.a]\nprompt = "a"\n[steps.b]\nprompt = "b"\nreviews = "a"')).toEqual({
      step: "b",
      key: "reviews",
      shape: false,
    });
    expect(one('[steps.a]\nprompt = "a"\nmax_rounds = 2')).toEqual({
      step: "a",
      key: "max_rounds",
      shape: false,
    });
    // The step that uses work a review may send back is the one to change.
    const ungated =
      '[steps.build]\nprompt = "b"\n' +
      '[steps.review]\ndepends_on = ["build"]\nreviews = "build"\nprompt = "r"\n' +
      '[steps.docs]\ndepends_on = ["build"]\nprompt = "d"';
    expect(one(ungated)).toEqual({ step: "docs", key: "depends_on", shape: false });
  });

  test("collects the problems of several steps at once", () => {
    const text =
      '[steps.a]\nprompt = "{{inptu}}"\n' +
      '[steps.b]\nprompt = "b"\nmax_rounds = 2\n' +
      '[steps.c]\nprompt = "c"\ndepends_on = ["zz"]\nreviews = "nope"';
    const check = checkWorkflow(text, "w");
    expect(check.definition).toBeNull();
    expect(check.shape).toBe(false);
    expect(check.problems).toEqual([
      { message: 'step "c" depends on unknown step "zz"', step: "c", key: "depends_on" },
      {
        message:
          'step "a" uses unknown placeholder {{inptu}}; use {{input}} or {{steps.<name>.result}}',
        step: "a",
        key: "prompt",
      },
      { message: 'step "b" sets max_rounds but reviews nothing', step: "b", key: "max_rounds" },
      { message: 'step "c" reviews unknown step "nope"', step: "c", key: "reviews" },
    ]);
    // parseWorkflow reports the first of them, as it always did.
    expect(() => parseWorkflow(text, "w")).toThrow('w: step "c" depends on unknown step "zz"');
  });

  test("collects schema errors of several steps, and parseWorkflow reports them all", () => {
    const text = '[steps.a]\nrole = "x"\n[steps.b]\nprompt = "b"\nbogus = 1';
    const check = checkWorkflow(text, "w");
    expect(check.shape).toBe(true);
    expect(check.problems.map(({ step, key }) => [step, key])).toEqual([
      ["a", "prompt"],
      ["b", undefined],
    ]);
    expect(check.problems[1]?.message).toContain("bogus");
    expect(() => parseWorkflow(text, "w")).toThrow(
      `w: ${check.problems.map((problem) => problem.message).join("; ")}`,
    );
  });

  test("gives the definition of a valid text, the same as parseWorkflow", () => {
    const check = checkWorkflow(FEATURE, "feature");
    expect(check).toEqual({
      definition: parseWorkflow(FEATURE, "feature"),
      problems: [],
      shape: false,
    });
  });

  test("parseWorkflow throws a WorkflowError that carries the problems", () => {
    const text = '[steps.a]\nprompt = "{{inptu}}"\n[steps.b]\nprompt = "b"\nmax_rounds = 2';
    let thrown: unknown;
    try {
      parseWorkflow(text, "w", "w.toml");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowError);
    expect(thrown).toBeInstanceOf(ConfigError);
    const error = thrown as WorkflowError;
    expect(error.message).toStartWith('w.toml: step "a" uses unknown placeholder');
    expect(error.problems).toEqual(checkWorkflow(text, "w").problems);
    expect(error.problems.map((problem) => problem.step)).toEqual(["a", "b"]);
  });
});

describe("review steps", () => {
  const reviewed = (extra: string) => `
[steps.build]
prompt = "b"
[steps.test]
depends_on = ["build"]
prompt = "t"
[steps.review]
depends_on = ["test"]
reviews = "build"
prompt = "r"
[steps.ship]
depends_on = ["review"]
prompt = "s"
${extra}`;

  test("a review names the step it may send back, and what is redone with it", () => {
    const workflow = parseWorkflow(reviewed(""), "w");
    expect(workflow.steps.review?.reviews).toBe("build");
    expect(reworkSteps(workflow, "review")).toEqual(["build", "test", "review"]);
    expect(reworkSteps(workflow, "ship")).toEqual([]);
  });

  test("rejects reviews that cannot work", () => {
    const bad = (text: string) => () => parseWorkflow(text, "w");
    expect(bad('[steps.a]\nprompt = "a"\nreviews = "nope"')).toThrow(
      'step "a" reviews unknown step "nope"',
    );
    expect(bad('[steps.a]\nprompt = "a"\n[steps.b]\nprompt = "b"\nreviews = "a"')).toThrow(
      'step "b" reviews "a" but does not depend on it',
    );
    expect(bad('[steps.a]\nprompt = "a"\nmax_rounds = 2')).toThrow(
      'step "a" sets max_rounds but reviews nothing',
    );
    expect(bad(reviewed('[steps.docs]\ndepends_on = ["build"]\nprompt = "d"'))).toThrow(
      'step "docs" depends on "build", which "review" reviews; make "docs" depend on "review", or "review" on "docs"',
    );
  });
});

describe("a definition as TOML", () => {
  const awkward = [
    "one line",
    'quotes "inside" and a \\ backslash',
    'two lines\nwith "quotes" and a \\ backslash',
    'ends with a quote"',
    'line\nends with quotes""',
    'has """ three quotes\ninside',
    "\nstarts with a newline\n",
    "tab\tand a control \u0001 character\nand \r return",
    "{{input}} and {{steps.a.result}}",
  ];

  test("parses back to the same definition", () => {
    for (const prompt of awkward) {
      const definition = parseWorkflow('[steps.a]\nprompt = "a"', "w");
      definition.description = "What it does";
      definition.steps.b = {
        prompt,
        role: "developer",
        profile: "me",
        model: "opus",
        effort: "high",
        permission_mode: "plan",
        deny_tools: ["Edit", "Write"],
        allow: ['Bash(git commit -m "x" *)'],
        mcp: ["github"],
        plugins: [],
        skills: ["review"],
        depends_on: ["a"],
        keep_agent: true,
        reviews: "a",
        max_rounds: 2,
      };
      const text = formatWorkflow(definition, ["a comment", "", "another"]);
      expect(text).toStartWith("# a comment\n#\n# another\n\n");
      expect(parseWorkflow(text, "w")).toEqual(definition);
    }
  });

  test("leaves out what is not set", () => {
    expect(formatWorkflow(parseWorkflow('[steps.a]\nprompt = "a"', "w"))).toBe(
      '[steps.a]\nprompt = "a"\n',
    );
  });

  test("sameWork ignores settings that do not change the work, and the order of dependencies", () => {
    const { steps } = parseWorkflow(
      '[steps.a]\nprompt = "a"\n[steps.b]\nprompt = "b"\n[steps.c]\nprompt = "c"\ndepends_on = ["a", "b"]',
      "w",
    );
    const c = steps.c;
    if (!c) throw new Error("no step c");
    expect(sameWork(c, { ...c, keep_agent: true, max_rounds: 5 })).toBe(true);
    expect(sameWork(c, { ...c, depends_on: ["b", "a"] })).toBe(true);
    expect(sameWork(c, { ...c, prompt: "other" })).toBe(false);
    expect(sameWork(c, { ...c, depends_on: ["a"] })).toBe(false);
    expect(sameWork(c, { ...c, model: "opus" })).toBe(false);
    // What the session may use is part of the work: a step redone with other tools is another step.
    expect(sameWork(c, { ...c, deny_tools: ["Edit"] })).toBe(false);
    expect(sameWork(c, { ...c, mcp: [] })).toBe(false);
    expect(sameWork({ ...c, skills: ["a"] }, { ...c, skills: ["a"] })).toBe(true);
  });

  test("a step takes the capability settings of a role, and not both tool lists", () => {
    const step = (settings: string) =>
      parseWorkflow(`[steps.a]\nprompt = "a"\n${settings}`, "w").steps.a;
    expect(step('tools = ["Read"]\nmcp = ["github"]')).toMatchObject({
      tools: ["Read"],
      mcp: ["github"],
    });
    expect(() => step('tools = ["Read"]\ndeny_tools = ["Edit"]')).toThrow(
      /set either tools or deny_tools/,
    );
    expect(() => step('permission_mode = "yolo"')).toThrow(/permission_mode/);
  });

  test("dependents are the steps that come after", () => {
    const workflow = parseWorkflow(
      '[steps.a]\nprompt = "a"\n[steps.b]\nprompt = "b"\ndepends_on = ["a"]\n[steps.c]\nprompt = "c"\ndepends_on = ["b"]\n[steps.d]\nprompt = "d"',
      "w",
    );
    expect(dependents(workflow, ["a"])).toEqual(["b", "c"]);
    expect(dependents(workflow, ["c", "d"])).toEqual([]);
  });
});

describe("renderPrompt and readySteps", () => {
  test("fills in the input and earlier results", () => {
    const workflow = parseWorkflow(FEATURE, "feature");
    expect(
      renderPrompt(workflow.steps.build?.prompt ?? "", "a login page", { explore: "see auth.ts" }),
    ).toBe("Implement a login page. Findings:\nsee auth.ts");
  });

  test("text put in by a placeholder is not expanded again", () => {
    expect(renderPrompt("{{input}}", "{{steps.a.result}}", { a: "secret" })).toBe(
      "{{steps.a.result}}",
    );
  });

  test("a step is ready when everything it depends on is done", () => {
    const workflow = parseWorkflow(FEATURE, "feature");
    expect(
      readySteps(workflow, { explore: "pending", build: "pending", review: "pending" }),
    ).toEqual(["explore"]);
    expect(
      readySteps(workflow, { explore: "running", build: "pending", review: "pending" }),
    ).toEqual([]);
    expect(readySteps(workflow, { explore: "done", build: "pending", review: "pending" })).toEqual([
      "build",
    ]);
    expect(readySteps(workflow, { explore: "done", build: "failed", review: "pending" })).toEqual(
      [],
    );
  });
});

describe("workflow files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dwa-test-"));
    mkdirSync(join(dir, ".dwa", "workflows"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("lists valid and broken files, and loads by name", () => {
    expect(listWorkflows(dir)).toEqual([]);
    writeFileSync(join(dir, ".dwa", "workflows", "feature.toml"), FEATURE);
    writeFileSync(join(dir, ".dwa", "workflows", "broken.toml"), "[steps");
    writeFileSync(join(dir, ".dwa", "workflows", "notes.md"), "not a workflow");

    const [broken, feature] = listWorkflows(dir);
    expect(broken?.name).toBe("broken");
    expect(broken?.error).toContain("invalid TOML");
    expect(feature).toEqual({
      name: "feature",
      personal: false,
      description: "Explore, build, review",
      steps: ["explore", "build", "review"],
      error: null,
    });

    expect(loadWorkflow(dir, "feature").name).toBe("feature");
    expect(() => loadWorkflow(dir, "nope")).toThrow(/Unknown workflow "nope" \(available: /);
    expect(() => loadWorkflow(dir, "../config")).toThrow(/Unknown workflow/);
    expect(() => loadWorkflow(dir, "broken")).toThrow(/invalid TOML/);
  });

  test("the example workflow is valid", async () => {
    const text = await Bun.file(
      join(import.meta.dir, "..", "examples", "workflows", "feature.toml"),
    ).text();
    expect(Object.keys(parseWorkflow(text, "feature").steps)).toEqual([
      "explore",
      "build",
      "review",
    ]);
  });
});

describe("personal workflows", () => {
  let dir: string;
  let ctx: ScopeContext;
  const ONE = '[steps.a]\nprompt = "a"\n';
  const project = (name: string) => join(dir, ".dwa", "workflows", `${name}.toml`);
  const personal = (name: string) => join(dir, "home", "dwa", "workflows", `${name}.toml`);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dwa-test-"));
    // A personal folder of its own: the real one is never read or written.
    ctx = { projectRoot: dir, env: { XDG_CONFIG_HOME: join(dir, "home") } };
    mkdirSync(join(dir, ".dwa", "workflows"), { recursive: true });
    mkdirSync(join(dir, "home", "dwa", "workflows"), { recursive: true });
    writeFileSync(project("feature"), FEATURE);
    writeFileSync(personal("feature"), `description = "Mine"\n\n${ONE}`);
    writeFileSync(personal("mine"), `description = "Only mine"\n\n${ONE}`);
    writeFileSync(personal("broken"), "[steps");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("listAllWorkflows has both files of a name and marks the personal one hidden", () => {
    expect(listAllWorkflows(ctx)).toEqual([
      { name: "broken", source: "user", path: personal("broken"), hidden: false },
      { name: "feature", source: "project", path: project("feature"), hidden: false },
      { name: "feature", source: "user", path: personal("feature"), hidden: true },
      { name: "mine", source: "user", path: personal("mine"), hidden: false },
    ]);
  });

  test("findWorkflow picks the project's file, and the personal one when the project has none", () => {
    expect(findWorkflow("feature", ctx)).toEqual({
      name: "feature",
      source: "project",
      path: project("feature"),
      hidden: false,
    });
    expect(findWorkflow("mine", ctx)?.path).toBe(personal("mine"));
    expect(findWorkflow("nope", ctx)).toBeNull();
    expect(findWorkflow("../feature", ctx)).toBeNull();
    rmSync(project("feature"));
    expect(findWorkflow("feature", ctx)).toMatchObject({ source: "user", hidden: false });
  });

  test("listWorkflows marks the personal ones and leaves out a hidden one", () => {
    expect(listWorkflows(dir, ctx.env)).toEqual([
      {
        name: "broken",
        personal: true,
        description: null,
        steps: [],
        error: expect.stringContaining("broken.toml: invalid TOML"),
      },
      {
        name: "feature",
        personal: false,
        description: "Explore, build, review",
        steps: ["explore", "build", "review"],
        error: null,
      },
      { name: "mine", personal: true, description: "Only mine", steps: ["a"], error: null },
    ]);
  });

  test("summarizeWorkflow describes one file, the hidden one included", () => {
    const hidden = listAllWorkflows(ctx).find((entry) => entry.hidden);
    if (!hidden) throw new Error("no hidden workflow");
    expect(summarizeWorkflow(hidden)).toEqual({
      name: "feature",
      personal: true,
      description: "Mine",
      steps: ["a"],
      error: null,
    });
  });

  test("loadWorkflow loads a personal workflow, and the project's of a name both have", () => {
    const mine = loadWorkflow(dir, "mine", ctx.env);
    expect(mine.name).toBe("mine");
    expect(mine.description).toBe("Only mine");
    expect(loadWorkflow(dir, "feature", ctx.env).description).toBe("Explore, build, review");
    expect(() => loadWorkflow(dir, "nope", ctx.env)).toThrow(
      'Unknown workflow "nope" (available: broken, feature, mine)',
    );
    expect(() => loadWorkflow(dir, "broken", ctx.env)).toThrow(WorkflowError);
  });

  test("workflowKind names the two folders", () => {
    expect(workflowKind.dir("project", ctx)).toBe(join(dir, ".dwa", "workflows"));
    expect(workflowKind.dir("user", ctx)).toBe(join(dir, "home", "dwa", "workflows"));
    expect(workflowKind.valid("feature-2")).toBe(true);
    expect(workflowKind.valid("a b")).toBe(false);
  });
});

test("describeRun shows each step and, when asked, the results", () => {
  const step = {
    attempt: 1,
    dependsOn: [],
    agent: null,
    result: null,
    error: null,
    needsAttention: false,
  };
  const run: WorkflowRunInfo = {
    id: 3,
    name: "feature",
    input: "x",
    state: "running",
    startedBy: "user",
    createdAt: 0,
    finishedAt: null,
    steps: [
      { ...step, id: "explore", state: "done", agent: "explore", result: "line 1\nline 2" },
      { ...step, id: "build", state: "running", agent: "build", needsAttention: true },
      { ...step, id: "review", state: "pending", dependsOn: ["build"] },
    ],
  };
  expect(describeRun(run)).toBe(
    [
      'Run #3 of "feature": running (started by user)',
      "  explore: done",
      '  build: running (agent "build"; needs attention)',
      "  review: pending (after build)",
    ].join("\n"),
  );
  expect(describeRun(run, true)).toContain("  explore: done\n      line 1\n      line 2\n");
});
