import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/shared/config.ts";
import type { WorkflowRunInfo } from "../src/shared/protocol.ts";
import {
  describeRun,
  listWorkflows,
  loadWorkflow,
  parseWorkflow,
  readySteps,
  renderPrompt,
  reworkSteps,
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

  const invalid: [string, string, RegExp][] = [
    ["broken TOML", "[steps", /invalid TOML/],
    ["no steps", 'description = "x"', /steps/],
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
  for (const [what, text, message] of invalid) {
    test(`rejects ${what}`, () => {
      expect(() => parseWorkflow(text, "w")).toThrow(ConfigError);
      expect(() => parseWorkflow(text, "w")).toThrow(message);
    });
  }
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
