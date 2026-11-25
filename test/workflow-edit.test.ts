// Changes to a workflow file: each one against the text (the rest of the file has to stay as it
// was, comments included), and the ones that write against a scratch project and a scratch home.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/shared/config.ts";
import { readHistory, versionText } from "../src/shared/history.ts";
import type { Scope, ScopeContext } from "../src/shared/scope.ts";
import {
  checkWorkflow,
  findWorkflow,
  listAllWorkflows,
  loadWorkflow,
  parseWorkflow,
  type WorkflowDefinition,
  WorkflowError,
} from "../src/shared/workflow.ts";
import {
  addStep,
  clearReview,
  conform,
  connect,
  createWorkflow,
  deleteWorkflow,
  disconnect,
  duplicateWorkflow,
  followRoleRename,
  insertOnEdge,
  looseSteps,
  makeReview,
  moveStep,
  moveWorkflow,
  noticeWorkflowEdits,
  placeBelow,
  placeBeside,
  removeStep,
  renameStep,
  renameWorkflow,
  requireWorkflow,
  roleMentions,
  saveWorkflowText,
  setDescription,
  setStepFields,
  switchWorkflow,
  workflowHistory,
  workflowTemplate,
  workflowWarnings,
} from "../src/shared/workflow-edit.ts";

const FEATURE = readFileSync(
  join(import.meta.dir, "..", "examples", "workflows", "feature.toml"),
  "utf8",
);
/** The example in pieces: the comment block with the description, then one piece per step. */
const cut = (from: string, to?: string) =>
  FEATURE.slice(FEATURE.indexOf(from), to ? FEATURE.indexOf(to) : undefined);
const F_HEAD = cut("#", "[steps.explore]");
const F_EXPLORE = cut("[steps.explore]", "\n[steps.build]");
const F_BUILD = cut("[steps.build]", "\n[steps.review]");
const F_REVIEW = cut("[steps.review]");
const F_COMMENT = F_HEAD.slice(0, F_HEAD.indexOf("description ="));

// A small text with a comment above every step and all three string forms for a prompt.
const HEAD = '# Head comment\ndescription = "d"\n\n';
const A = '# first\n[steps.a]\nprompt = "a {{input}}"\n';
const B = '# second\n[steps.b]\ndepends_on = ["a"]\nprompt = """\nb {{steps.a.result}}\n"""\n';
const C =
  '# third\n[steps.c]\ndepends_on = ["b"]\nreviews = "b"\nmax_rounds = 2\n' +
  "prompt = '''\nc {{ steps.b.result }} and {{steps.a.result}}\n'''\n";
const D =
  '# fourth\n[steps.d]\ndepends_on = ["c"]\nkeep_agent = true\ntools = ["Read"]\nprompt = "d"\n';
const SMALL = `${HEAD}${A}\n${B}\n${C}\n${D}`;

// Three steps that only have a prompt, two of them side by side under the first.
const U_A = '# ca\n[steps.a]\nprompt = "a"\n';
const U_B = '# cb\n[steps.b]\nprompt = "b"\n';
const U_C = '# cc\n[steps.c]\ndepends_on = ["a"]\nprompt = "c"\n';
const LOOSE = `# Loose head\n\n${U_A}\n${U_B}\n${U_C}`;

/** `text` with one piece replaced; the piece has to be there exactly once. */
function swap(text: string, from: string, to: string): string {
  expect(text.split(from)).toHaveLength(2);
  return text.replace(from, () => to);
}

/** What each step depends on, in file order, valid workflow or not. */
function chain(text: string): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(looseSteps(text)).map(([id, step]) => [id, step.depends_on]),
  );
}

const fields = (text: string, id: string) => looseSteps(text)[id]?.fields;
const problems = (text: string) => checkWorkflow(text, "w").problems;

test("the pieces are the texts", () => {
  expect(`${F_HEAD}${F_EXPLORE}\n${F_BUILD}\n${F_REVIEW}`).toBe(FEATURE);
  expect(F_COMMENT).toStartWith("# Explore, build, review.");
  expect(F_COMMENT).toEndWith("after max_rounds passes you are asked what to do.\n");
  expect(problems(FEATURE)).toEqual([]);
  expect(problems(SMALL)).toEqual([]);
  expect(problems(LOOSE)).toEqual([]);
});

describe("addStep", () => {
  test("adds a step at the end with an empty prompt, which the check names", () => {
    const after = addStep(FEATURE, "ship", {});
    expect(after).toBe(`${FEATURE}\n[steps.ship]\nprompt = ""\n`);
    expect(problems(after)).toMatchObject([{ step: "ship", key: "prompt" }]);
    expect(problems(after)).toHaveLength(1);
  });

  test("adds a step before another with its keys in the usual order, the prompt last", () => {
    const after = addStep(
      FEATURE,
      "plan",
      {
        prompt: "Plan it",
        depends_on: ["explore"],
        keep_agent: false,
        model: "opus",
        role: "developer",
      },
      "build",
    );
    const plan =
      '[steps.plan]\nrole = "developer"\nmodel = "opus"\ndepends_on = ["explore"]\nprompt = "Plan it"\n';
    expect(after).toBe(`${F_HEAD}${F_EXPLORE}\n${plan}\n${F_BUILD}\n${F_REVIEW}`);
    const workflow = parseWorkflow(after, "feature");
    expect(Object.keys(workflow.steps)).toEqual(["explore", "plan", "build", "review"]);
    expect(workflow.steps.plan).toEqual({
      role: "developer",
      model: "opus",
      depends_on: ["explore"],
      keep_agent: false,
      prompt: "Plan it",
    });
  });

  test("goes under the comment of the step it is put before, and keeps every comment", () => {
    const after = addStep(SMALL, "e", { prompt: "e", keep_agent: true }, "c");
    expect(after).toBe(
      `${HEAD}${A}\n${B}\n[steps.e]\nkeep_agent = true\nprompt = "e"\n\n${C}\n${D}`,
    );
  });

  test("a multi-line prompt and one tool list are written as given", () => {
    const after = addStep(SMALL, "e", { prompt: "one\ntwo {{input}}\n", deny_tools: ["Edit"] });
    expect(after).toBe(
      `${SMALL}\n[steps.e]\ndeny_tools = ["Edit"]\nprompt = """\none\ntwo {{input}}\n"""\n`,
    );
    expect(parseWorkflow(after, "w").steps.e?.prompt).toBe("one\ntwo {{input}}\n");
  });

  test("is refused for a name that is taken or cannot be one, and for an unknown place", () => {
    expect(() => addStep(FEATURE, "build", {})).toThrow(ConfigError);
    expect(() => addStep(FEATURE, "build", {})).toThrow('There is already a step "build".');
    expect(() => addStep(FEATURE, "a b", {})).toThrow('"a b" cannot be a step name');
    expect(() => addStep(FEATURE, "ship", {}, "nowhere")).toThrow();
  });
});

describe("removeStep", () => {
  test("heals the chain: what depended on the step depends on what it depended on", () => {
    const after = removeStep(SMALL, "b");
    expect(after).toBe(`${HEAD}${A}\n${swap(C, 'depends_on = ["b"]', 'depends_on = ["a"]')}\n${D}`);
    expect(chain(after)).toEqual({ a: [], c: ["a"], d: ["c"] });
  });

  test("leaves a placeholder and a review of the removed step for the check to name", () => {
    const after = removeStep(SMALL, "b");
    expect(after).toContain('reviews = "b"');
    expect(after).toContain("{{ steps.b.result }}");
    expect(problems(after)).toEqual([
      {
        message: 'step "c" uses the result of "b" but does not depend on it',
        step: "c",
        key: "prompt",
      },
      { message: 'step "c" reviews unknown step "b"', step: "c", key: "reviews" },
    ]);
  });

  test("in the example, the review takes over the build's dependency", () => {
    const after = removeStep(FEATURE, "build");
    expect(after).toBe(
      `${F_HEAD}${F_EXPLORE}\n${swap(F_REVIEW, 'depends_on = ["build"]', 'depends_on = ["explore"]')}`,
    );
    expect(problems(after).map(({ step, key }) => [step, key])).toEqual([
      ["review", "prompt"],
      ["review", "reviews"],
    ]);
  });

  test("a step that depended on the first step alone loses the key", () => {
    const after = removeStep(SMALL, "a");
    expect(after).toBe(`${HEAD}${swap(B, 'depends_on = ["a"]\n', "")}\n${C}\n${D}`);
    expect(chain(after)).toEqual({ b: [], c: ["b"], d: ["c"] });
  });

  test("the last step goes without a trace, and dependencies are put in place without repeats", () => {
    expect(removeStep(SMALL, "d")).toBe(`${HEAD}${A}\n${B}\n${C}`);
    const text =
      '[steps.p]\nprompt = "p"\n\n[steps.r]\nprompt = "r"\n\n' +
      '[steps.gone]\ndepends_on = ["r", "p"]\nprompt = "g"\n\n' +
      '# keeps\n[steps.x]\ndepends_on = ["p", "gone", "q"]\nprompt = "x"\n\n' +
      '[steps.q]\nprompt = "q"\n';
    const after = removeStep(text, "gone");
    expect(chain(after)).toEqual({ p: [], r: [], x: ["p", "r", "q"], q: [] });
    expect(after).toContain('# keeps\n[steps.x]\ndepends_on = ["p", "r", "q"]\nprompt = "x"\n');
  });

  test("is refused for a step that is not there", () => {
    expect(() => removeStep(SMALL, "zz")).toThrow('There is no step "zz".');
  });
});

describe("renameStep", () => {
  test("follows the name through depends_on, reviews and prompts of every string form", () => {
    const renamed = renameStep(SMALL, "a", "start");
    expect(renamed).toBe(
      `${HEAD}${swap(A, "[steps.a]", "[steps.start]")}\n` +
        `${swap(swap(B, '["a"]', '["start"]'), "{{steps.a.result}}", "{{steps.start.result}}")}\n` +
        `${swap(C, "{{steps.a.result}}", "{{steps.start.result}}")}\n${D}`,
    );
    expect(problems(renamed)).toEqual([]);

    const after = renameStep(SMALL, "b", "make");
    const c = swap(
      swap(
        swap(C, 'depends_on = ["b"]', 'depends_on = ["make"]'),
        'reviews = "b"',
        'reviews = "make"',
      ),
      "{{ steps.b.result }}",
      "{{steps.make.result}}",
    );
    expect(after).toBe(`${HEAD}${A}\n${swap(B, "[steps.b]", "[steps.make]")}\n${c}\n${D}`);
    const workflow = parseWorkflow(after, "w");
    expect(Object.keys(workflow.steps)).toEqual(["a", "make", "c", "d"]);
    expect(workflow.steps.c).toMatchObject({
      depends_on: ["make"],
      reviews: "make",
      max_rounds: 2,
    });
    // The literal string is still one, with its line breaks.
    expect(workflow.steps.c?.prompt).toBe("c {{steps.make.result}} and {{steps.a.result}}\n");
  });

  test("renames a step of the example and leaves its comment block alone", () => {
    const after = renameStep(FEATURE, "build", "implement");
    const review = F_REVIEW.replace('depends_on = ["build"]', 'depends_on = ["implement"]')
      .replace('reviews = "build"', 'reviews = "implement"')
      .replace("{{steps.build.result}}", "{{steps.implement.result}}");
    expect(after).toBe(
      `${F_HEAD}${F_EXPLORE}\n${swap(F_BUILD, "[steps.build]", "[steps.implement]")}\n${review}`,
    );
    expect(Object.keys(parseWorkflow(after, "feature").steps)).toEqual([
      "explore",
      "implement",
      "review",
    ]);
  });

  test("a name that begins like another is not mistaken for it", () => {
    const text =
      '[steps.a]\nprompt = "a"\n\n[steps.ab]\nprompt = "ab"\n\n' +
      '[steps.c]\ndepends_on = ["a", "ab"]\nprompt = "{{steps.ab.result}} {{steps.a.result}}"\n';
    const after = renameStep(text, "a", "z");
    expect(after).toBe(
      '[steps.z]\nprompt = "a"\n\n[steps.ab]\nprompt = "ab"\n\n' +
        '[steps.c]\ndepends_on = ["z", "ab"]\nprompt = "{{steps.ab.result}} {{steps.z.result}}"\n',
    );
  });

  test("changes nothing for the same name and is refused for a taken, bad or missing one", () => {
    expect(renameStep(SMALL, "b", "b")).toBe(SMALL);
    expect(() => renameStep(SMALL, "b", "c")).toThrow('There is already a step "c".');
    expect(() => renameStep(SMALL, "b", "x y")).toThrow("cannot be a step name");
    expect(() => renameStep(SMALL, "zz", "y")).toThrow('There is no step "zz".');
  });
});

describe("setStepFields", () => {
  test("sets and adds keys of one step, new ones before the prompt", () => {
    const after = setStepFields(SMALL, "d", { role: "r", model: "opus" });
    expect(after).toBe(
      `${HEAD}${A}\n${B}\n${C}\n${swap(D, 'tools = ["Read"]\n', 'tools = ["Read"]\nrole = "r"\nmodel = "opus"\n')}`,
    );
    expect(parseWorkflow(after, "w").steps.d).toMatchObject({ role: "r", model: "opus" });
  });

  test("null removes a key, and so do an empty depends_on and keep_agent = false", () => {
    const cleared = setStepFields(SMALL, "c", { max_rounds: null, reviews: null, depends_on: [] });
    expect(cleared).toBe(
      `${HEAD}${A}\n${B}\n${swap(C, 'depends_on = ["b"]\nreviews = "b"\nmax_rounds = 2\n', "")}\n${D}`,
    );
    const quiet = setStepFields(SMALL, "d", { keep_agent: false });
    expect(quiet).toBe(`${HEAD}${A}\n${B}\n${C}\n${swap(D, "keep_agent = true\n", "")}`);
    expect(parseWorkflow(quiet, "w").steps.d?.keep_agent).toBe(false);
    // Removing what is not there changes nothing.
    expect(setStepFields(SMALL, "a", { role: null, keep_agent: false, depends_on: [] })).toBe(
      SMALL,
    );
  });

  test("a step that gets one tool list loses the other", () => {
    const denied = setStepFields(SMALL, "d", { deny_tools: ["Edit"] });
    expect(fields(denied, "d")).toEqual({
      depends_on: ["c"],
      keep_agent: true,
      deny_tools: ["Edit"],
      prompt: "d",
    });
    expect(denied).toStartWith(`${HEAD}${A}\n${B}\n${C}\n# fourth\n[steps.d]\n`);
    const allowed = setStepFields(denied, "d", { tools: ["Read", "Grep"] });
    expect(fields(allowed, "d")).toMatchObject({ tools: ["Read", "Grep"] });
    expect(fields(allowed, "d")).not.toHaveProperty("deny_tools");
    expect(problems(allowed)).toEqual([]);
    // Unless the change itself says what happens to the other one.
    const none = setStepFields(SMALL, "d", { deny_tools: ["Edit"], tools: null });
    expect(fields(none, "d")).not.toHaveProperty("tools");
  });

  test("replaces a prompt and leaves the other steps as they are", () => {
    const after = setStepFields(SMALL, "b", { prompt: "new\nprompt {{steps.a.result}}\n" });
    expect(after).toBe(
      `${HEAD}${A}\n${swap(B, "b {{steps.a.result}}", "new\nprompt {{steps.a.result}}")}\n${C}\n${D}`,
    );
  });

  test("is refused for a step that is not there", () => {
    expect(() => setStepFields(SMALL, "zz", { role: "r" })).toThrow('There is no step "zz".');
  });
});

describe("moveStep and setDescription", () => {
  test("moves a step with its comment, to the front and to the end", () => {
    const front = moveStep(SMALL, "d", "a");
    expect(front).toBe(`${HEAD}${D}\n${A}\n${B}\n${C}`);
    expect(Object.keys(parseWorkflow(front, "w").steps)).toEqual(["d", "a", "b", "c"]);
    expect(moveStep(SMALL, "a", null)).toBe(`${HEAD}${B}\n${C}\n${D}\n${A}`);
    expect(moveStep(FEATURE, "review", "build")).toBe(
      `${F_HEAD}${F_EXPLORE}\n${F_REVIEW}\n${F_BUILD}`,
    );
    expect(() => moveStep(SMALL, "zz", null)).toThrow('There is no step "zz".');
  });

  test("sets, removes and adds the description", () => {
    expect(setDescription(SMALL, "new one")).toBe(
      swap(SMALL, 'description = "d"', 'description = "new one"'),
    );
    expect(setDescription(SMALL, null)).toBe(`# Head comment\n\n${A}\n${B}\n${C}\n${D}`);
    expect(setDescription(SMALL, "")).toBe(setDescription(SMALL, null));
    const changed = setDescription(FEATURE, "Another");
    expect(changed).toBe(
      `${F_COMMENT}description = "Another"\n\n${F_EXPLORE}\n${F_BUILD}\n${F_REVIEW}`,
    );
    // A text without one gets it before the first step.
    const bare = '[steps.a]\nprompt = "a"\n';
    expect(setDescription(bare, "added")).toBe(`description = "added"\n\n${bare}`);
    expect(parseWorkflow(setDescription(LOOSE, "added"), "w").description).toBe("added");
    expect(setDescription(LOOSE, "added")).toEndWith(`\n${U_B}\n${U_C}`);
  });

  // Today the description is put between the first step's comment and its header.
  test("a new description does not come between the first step and its comment", () => {
    expect(setDescription(LOOSE, "added")).toBe(
      `# Loose head\n\ndescription = "added"\n\n${U_A}\n${U_B}\n${U_C}`,
    );
  });
});

describe("connect and disconnect", () => {
  test("connect adds a dependency after the ones the step has", () => {
    const after = connect(SMALL, "a", "d");
    expect(after).toBe(swap(SMALL, 'depends_on = ["c"]', 'depends_on = ["c", "a"]'));
    expect(connect(SMALL, "a", "b")).toBe(SMALL);
  });

  test("connect gives a step its first dependency", () => {
    const after = connect(LOOSE, "a", "b");
    expect(chain(after)).toEqual({ a: [], b: ["a"], c: ["a"] });
    expect(problems(after)).toEqual([]);
    expect(after).toStartWith(`# Loose head\n\n${U_A}\n# cb\n[steps.b]\ndepends_on = ["a"]\n`);
    expect(after).toEndWith(`prompt = "b"\n\n${U_C}`);
  });

  // Today an empty line is left between the new key and the prompt (see setKeys, the `tail` case).
  test("a key added to a step that only has a prompt goes right above the prompt", () => {
    expect(connect(LOOSE, "a", "b")).toBe(
      `# Loose head\n\n${U_A}\n${swap(U_B, "[steps.b]\n", '[steps.b]\ndepends_on = ["a"]\n')}\n${U_C}`,
    );
  });

  test("connect refuses a loop, direct or through other steps, and a step on itself", () => {
    expect(() => connect(SMALL, "d", "a")).toThrow(ConfigError);
    expect(() => connect(SMALL, "d", "a")).toThrow(
      '"d" already depends on "a"; the other way round is a loop.',
    );
    expect(() => connect(SMALL, "b", "a")).toThrow("is a loop");
    expect(() => connect(SMALL, "a", "a")).toThrow("A step cannot depend on itself.");
    expect(() => connect(SMALL, "zz", "a")).toThrow('There is no step "zz".');
    expect(() => connect(SMALL, "a", "zz")).toThrow('There is no step "zz".');
  });

  test("disconnect takes one dependency away, and the key with the last one", () => {
    expect(disconnect(SMALL, "c", "d")).toBe(swap(SMALL, 'depends_on = ["c"]\n', ""));
    const two = connect(SMALL, "a", "d");
    expect(disconnect(two, "c", "d")).toBe(swap(SMALL, 'depends_on = ["c"]', 'depends_on = ["a"]'));
    expect(disconnect(SMALL, "a", "d")).toBe(SMALL);
    expect(() => disconnect(SMALL, "a", "zz")).toThrow('There is no step "zz".');
  });
});

describe("makeReview and clearReview", () => {
  test("makes a step that already comes after the target its review, with the passes", () => {
    const after = makeReview(SMALL, "d", "a", 5);
    expect(after).toBe(
      swap(SMALL, 'tools = ["Read"]\n', 'tools = ["Read"]\nreviews = "a"\nmax_rounds = 5\n'),
    );
    // d comes after a through c and b: no dependency had to be added.
    expect(chain(after).d).toEqual(["c"]);
    expect(problems(after)).toEqual([]);
    expect(fields(makeReview(SMALL, "d", "c"), "d")).not.toHaveProperty("max_rounds");
  });

  test("adds the dependency a review needs when it is missing", () => {
    const text = `${U_A}\n${U_B}\n# cc\n[steps.c]\ndepends_on = ["b"]\nprompt = "c"\n`;
    const after = makeReview(text, "b", "a", 4);
    expect(fields(after, "b")).toEqual({
      depends_on: ["a"],
      reviews: "a",
      max_rounds: 4,
      prompt: "b",
    });
    expect(parseWorkflow(after, "w").steps.b).toMatchObject({ reviews: "a", max_rounds: 4 });
    expect(after).toStartWith(`${U_A}\n# cb\n[steps.b]\n`);
    expect(after).toEndWith(`\n# cc\n[steps.c]\ndepends_on = ["b"]\nprompt = "c"\n`);
    const plain = makeReview(text, "b", "a");
    expect(fields(plain, "b")).toEqual({ depends_on: ["a"], reviews: "a", prompt: "b" });
  });

  test("changes the target and the passes of a step that is a review already", () => {
    const after = makeReview(SMALL, "c", "a", 4);
    expect(after).toBe(
      swap(SMALL, 'reviews = "b"\nmax_rounds = 2', 'reviews = "a"\nmax_rounds = 4'),
    );
  });

  test("is refused for a step on itself, for a loop and for steps that are not there", () => {
    expect(() => makeReview(SMALL, "b", "b")).toThrow("A step cannot review itself.");
    expect(() => makeReview(SMALL, "a", "d")).toThrow("is a loop");
    expect(() => makeReview(SMALL, "zz", "a")).toThrow('There is no step "zz".');
    expect(() => makeReview(SMALL, "a", "zz")).toThrow('There is no step "zz".');
  });

  test("clearReview makes the step an ordinary one and keeps its dependency", () => {
    const after = clearReview(SMALL, "c");
    expect(after).toBe(swap(SMALL, 'reviews = "b"\nmax_rounds = 2\n', ""));
    expect(problems(after)).toEqual([]);
    expect(clearReview(SMALL, "d")).toBe(SMALL);
  });
});

describe("placing a step", () => {
  /** The comment lines above each step, by step: they have to travel with it. */
  function comments(text: string): Record<string, string> {
    const lines = text.split("\n");
    const out: Record<string, string> = {};
    lines.forEach((line, index) => {
      const id = /^\[steps\.(.+)\]$/.exec(line)?.[1];
      if (id) out[id] = lines[index - 1] ?? "";
    });
    return out;
  }
  const SMALL_COMMENTS = { a: "# first", b: "# second", c: "# third", d: "# fourth" };
  const LOOSE_COMMENTS = { a: "# ca", b: "# cb", c: "# cc" };

  test("insertOnEdge puts a loose step between two that follow each other", () => {
    const after = insertOnEdge(LOOSE, "b", "a", "c");
    expect(chain(after)).toEqual({ a: [], b: ["a"], c: ["b"] });
    expect(problems(after)).toEqual([]);
    expect(comments(after)).toEqual(LOOSE_COMMENTS);
    expect(after).toStartWith(`# Loose head\n\n${U_A}\n# cb\n[steps.b]\n`);
    expect(after).toEndWith(`\n${swap(U_C, '["a"]', '["b"]')}`);
  });

  test("insertOnEdge lifts a step out of where it was and moves it in the file", () => {
    const after = insertOnEdge(SMALL, "d", "a", "b");
    const d =
      '# fourth\n[steps.d]\nkeep_agent = true\ntools = ["Read"]\ndepends_on = ["a"]\nprompt = "d"\n';
    expect(after).toBe(`${HEAD}${A}\n${d}\n${swap(B, '["a"]', '["d"]')}\n${C}`);
    expect(problems(after)).toEqual([]);

    // A step from the middle: what followed it is joined to what it followed.
    const middle = insertOnEdge(SMALL, "b", "c", "d");
    expect(chain(middle)).toEqual({ a: [], c: ["a"], b: ["c"], d: ["b"] });
    expect(comments(middle)).toEqual(SMALL_COMMENTS);
    expect(middle).toStartWith(`${HEAD}${A}\n# third\n`);
    // Only the edge named changes on the far side; other dependencies of `to` stay.
    const two = connect(SMALL, "a", "d");
    expect(chain(insertOnEdge(addStep(two, "e", { prompt: "e" }), "e", "c", "d"))).toEqual({
      a: [],
      b: ["a"],
      c: ["b"],
      e: ["c"],
      d: ["e", "a"],
    });
    expect(insertOnEdge(SMALL, "a", "a", "b")).toBe(SMALL);
    expect(insertOnEdge(SMALL, "b", "a", "b")).toBe(SMALL);
  });

  test("placeBeside gives a step the dependencies of its neighbour and puts it after it", () => {
    const after = placeBeside(SMALL, "d", "b");
    const d =
      '# fourth\n[steps.d]\nkeep_agent = true\ntools = ["Read"]\ndepends_on = ["a"]\nprompt = "d"\n';
    expect(after).toBe(`${HEAD}${A}\n${B}\n${d}\n${C}`);
    expect(problems(after)).toEqual([]);

    const loose = placeBeside(LOOSE, "b", "c");
    expect(chain(loose)).toEqual({ a: [], c: ["a"], b: ["a"] });
    expect(comments(loose)).toEqual(LOOSE_COMMENTS);
    expect(loose).toStartWith(`# Loose head\n\n${U_A}\n${U_C}\n# cb\n[steps.b]\n`);
    // Beside a first step: no dependencies at all.
    const first = placeBeside(SMALL, "d", "a");
    expect(chain(first)).toEqual({ a: [], d: [], b: ["a"], c: ["b"] });
    expect(placeBeside(SMALL, "b", "b")).toBe(SMALL);
  });

  test("placeBelow makes a step depend on one step alone, after that step's other children", () => {
    const after = placeBelow(LOOSE, "b", "a");
    expect(chain(after)).toEqual({ a: [], c: ["a"], b: ["a"] });
    expect(comments(after)).toEqual(LOOSE_COMMENTS);
    expect(problems(after)).toEqual([]);

    // Right under its new parent when that has no other children.
    const under = placeBelow(SMALL, "d", "a");
    expect(chain(under)).toEqual({ a: [], b: ["a"], d: ["a"], c: ["b"] });
    expect(comments(under)).toEqual(SMALL_COMMENTS);

    // A step from the middle leaves the chain whole; what named it is for the check to say.
    const moved = placeBelow(SMALL, "b", "d");
    expect(chain(moved)).toEqual({ a: [], c: ["a"], d: ["c"], b: ["d"] });
    expect(moved).toStartWith(`${HEAD}${A}\n# third\n`);
    expect(problems(moved).map(({ step, key }) => [step, key])).toEqual([
      ["c", "prompt"],
      ["c", "reviews"],
    ]);
    expect(placeBelow(SMALL, "b", "b")).toBe(SMALL);
  });
});

describe("conform", () => {
  const base = () => parseWorkflow(SMALL, "w");
  /** Conforms `text` to `target` and checks the one thing that always has to hold. */
  function conformed(
    text: string,
    target: WorkflowDefinition,
    renames?: Record<string, string>,
  ): string {
    const after = conform(text, target, renames);
    const parsed = parseWorkflow(after, target.name);
    expect(parsed).toEqual(target);
    expect(Object.keys(parsed.steps)).toEqual(Object.keys(target.steps));
    return after;
  }

  test("a text that already says it is not touched", () => {
    expect(conform(SMALL, base())).toBe(SMALL);
    expect(conform(FEATURE, parseWorkflow(FEATURE, "feature"))).toBe(FEATURE);
  });

  test("a changed field changes that step only", () => {
    const target = base();
    Object.assign(target.steps.b as object, { role: "developer", prompt: "other {{input}}" });
    (target.steps.d as { keep_agent: boolean }).keep_agent = false;
    delete (target.steps.d as { tools?: string[] }).tools;
    (target.steps.c as { max_rounds?: number }).max_rounds = 7;
    const after = conformed(SMALL, target);
    expect(after).toStartWith(`${HEAD}${A}\n# second\n[steps.b]\n`);
    expect(after).toContain(swap(C, "max_rounds = 2", "max_rounds = 7"));
    expect(after).toEndWith('\n# fourth\n[steps.d]\ndepends_on = ["c"]\nprompt = "d"\n');
  });

  test("a step that was added is written where the target has it", () => {
    const target = base();
    target.steps = {
      a: target.steps.a,
      b: target.steps.b,
      extra: { prompt: "e {{steps.a.result}}", depends_on: ["a"], keep_agent: true, model: "opus" },
      c: target.steps.c,
      d: target.steps.d,
    } as WorkflowDefinition["steps"];
    const after = conformed(SMALL, target);
    expect(after).toStartWith(`${HEAD}${A}\n${B}\n[steps.extra]\n`);
    expect(after).toEndWith(`\n${C}\n${D}`);
  });

  test("a step that was removed goes with its comment, the others stay", () => {
    const target = parseWorkflow(`${HEAD}${A}\n${B}\n${swap(D, '["c"]', '["b"]')}`, "w");
    const after = conformed(SMALL, target);
    expect(after).toBe(`${HEAD}${A}\n${B}\n${swap(D, '["c"]', '["b"]')}`);
    expect(after).not.toContain("# third");
  });

  test("a rename that is given keeps the step's place and comment", () => {
    const target = parseWorkflow(renameStep(SMALL, "b", "make"), "w");
    const after = conformed(SMALL, target, { b: "make" });
    expect(after).toBe(renameStep(SMALL, "b", "make"));
    expect(after).toContain("# second\n[steps.make]\n");
    // With another change to the renamed step on top.
    (target.steps.make as { role?: string }).role = "developer";
    const more = conformed(SMALL, target, { b: "make" });
    expect(more).toContain("# second\n[steps.make]\n");
    expect(more).toStartWith(`${HEAD}${A}\n`);
    expect(more).toEndWith(`\n${D}`);
  });

  test("a rename that is not given counts as a step removed and one added", () => {
    const target = parseWorkflow(renameStep(SMALL, "b", "make"), "w");
    const after = conformed(SMALL, target);
    expect(after).not.toContain("# second");
    expect(after).toStartWith(`${HEAD}${A}\n[steps.make]\n`);
    expect(after).toContain("# third\n[steps.c]\n");
    expect(after).toEndWith(`\n${D}`);
  });

  test("a rename that does not apply is ignored", () => {
    const target = base();
    expect(conformed(SMALL, target, { zz: "yy", b: "gone" })).toBe(SMALL);
  });

  test("steps in another order are moved with their comments", () => {
    const target = base();
    const { a, b, c, d } = target.steps;
    target.steps = { d, a, c, b } as WorkflowDefinition["steps"];
    const after = conformed(SMALL, target);
    expect(after).toBe(`${HEAD}${D}\n${A}\n${C}\n${B}`);
  });

  test("the description is changed, removed and added", () => {
    const target = base();
    target.description = "Something else";
    expect(conformed(SMALL, target)).toBe(
      swap(SMALL, 'description = "d"', 'description = "Something else"'),
    );
    delete target.description;
    expect(conformed(SMALL, target)).toBe(`# Head comment\n\n${A}\n${B}\n${C}\n${D}`);
    const bare = parseWorkflow(LOOSE, "w");
    bare.description = "Now it has one";
    expect(conformed(LOOSE, bare)).toEndWith(`\n${U_B}\n${U_C}`);
  });

  test("the example conforms to an edited run copy and keeps its comment block", () => {
    const target = parseWorkflow(FEATURE, "feature");
    target.description = "Explore, plan, build, review";
    const { explore, build, review } = target.steps;
    target.steps = {
      explore,
      plan: {
        prompt: "Plan: {{steps.explore.result}}",
        depends_on: ["explore"],
        keep_agent: false,
      },
      implement: { ...build, depends_on: ["plan"] },
      review: {
        ...review,
        depends_on: ["implement"],
        reviews: "implement",
        max_rounds: 2,
        prompt: (review?.prompt ?? "").replace("steps.build.", "steps.implement."),
      },
    } as WorkflowDefinition["steps"];
    const after = conformed(FEATURE, target, { build: "implement" });
    expect(after).toStartWith(
      `${F_COMMENT}description = "Explore, plan, build, review"\n\n${F_EXPLORE}\n[steps.plan]\n`,
    );
    expect(after).toContain(
      '[steps.implement]\nrole = "developer"\ndepends_on = ["plan"]\nprompt = """\nImplement this change: {{input}}\n',
    );
  });

  test("everything at once still ends at the target", () => {
    const target = base();
    const { a, c, d } = target.steps;
    target.description = "All of it";
    target.steps = {
      fresh: { prompt: "f", depends_on: [], keep_agent: false },
      last: { ...d, depends_on: ["fresh"] },
      a: { ...a, depends_on: ["fresh"], role: "explore" },
      review: { ...c, depends_on: ["a"], reviews: "a", prompt: "r {{steps.a.result}}" },
    } as WorkflowDefinition["steps"];
    const after = conformed(SMALL, target, { c: "review", d: "last" });
    expect(after).toContain("# third\n[steps.review]\n");
    expect(after).toContain("# fourth\n[steps.last]\n");
    expect(after).toContain("# first\n[steps.a]\n");
    expect(after).not.toContain("# second");
    expect(after).toStartWith("# Head comment\n");
  });
});

describe("workflow files", () => {
  let dir: string;
  let ctx: ScopeContext;
  const ONE = workflowTemplate("One step");
  const TWO = '# mine\n[steps.a]\nrole = "explore"\nprompt = "a"\n';
  const folder = (source: Scope) =>
    source === "user" ? join(dir, "home", "dwa", "workflows") : join(dir, ".dwa", "workflows");
  const file = (source: Scope, name: string) => join(folder(source), `${name}.toml`);
  const text = (source: Scope, name: string) => readFileSync(file(source, name), "utf8");
  const historyDir = (source: Scope, name: string) =>
    source === "user"
      ? join(dir, "home", "dwa", "history", "workflows", name)
      : join(dir, ".dwa", "history", "workflows", name);
  /** A file written as an editor would, without dwa knowing. */
  function byHand(source: Scope, name: string, content: string): void {
    mkdirSync(folder(source), { recursive: true });
    writeFileSync(file(source, name), content);
  }
  const sources = (ref: Parameters<typeof workflowHistory>[0]) =>
    readHistory(workflowHistory(ref, ctx)).versions.map((version) => version.source);
  const places = () =>
    listAllWorkflows(ctx).map((entry) => [entry.name, entry.source, entry.hidden]);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dwa-workflow-edit-"));
    // A personal folder of its own: the real one is never read or written.
    ctx = { projectRoot: dir, env: { XDG_CONFIG_HOME: join(dir, "home") } };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("the template is a valid workflow with and without a description", () => {
    expect(ONE).toBe('description = "One step"\n\n[steps.work]\nprompt = """\n{{input}}\n"""\n');
    expect(parseWorkflow(ONE, "w").steps.work?.prompt).toBe("{{input}}\n");
    expect(parseWorkflow(workflowTemplate(""), "w").description).toBeUndefined();
  });

  describe("createWorkflow", () => {
    test("creates a project file and a personal file, each with its first version", () => {
      const made = createWorkflow("feature", ONE, "workflow new", ctx);
      expect(made).toEqual({
        name: "feature",
        source: "project",
        path: file("project", "feature"),
        hidden: false,
      });
      expect(text("project", "feature")).toBe(ONE);
      expect(readFileSync(join(historyDir("project", "feature"), "v1.toml"), "utf8")).toBe(ONE);
      expect(sources("feature")).toEqual(["workflow new"]);

      const mine = createWorkflow("mine", TWO, "designer", ctx, { personal: true });
      expect(mine).toMatchObject({ source: "user", path: file("user", "mine"), hidden: false });
      expect(text("user", "mine")).toBe(TWO);
      expect(existsSync(join(historyDir("user", "mine"), "v1.toml"))).toBe(true);
      expect(existsSync(historyDir("project", "mine"))).toBe(false);
      expect(existsSync(file("project", "mine"))).toBe(false);
      expect(places()).toEqual([
        ["feature", "project", false],
        ["mine", "user", false],
      ]);
      expect(loadWorkflow(dir, "mine", ctx.env).steps.a?.role).toBe("explore");
    });

    test("is refused for a name that is taken in either place, or that cannot be one", () => {
      createWorkflow("feature", ONE, "x", ctx);
      createWorkflow("mine", ONE, "x", ctx, { personal: true });
      expect(() => createWorkflow("feature", TWO, "x", ctx)).toThrow(
        'There is already a workflow "feature".',
      );
      expect(() => createWorkflow("feature", TWO, "x", ctx, { personal: true })).toThrow(
        'There is already a workflow "feature".',
      );
      expect(() => createWorkflow("mine", TWO, "x", ctx)).toThrow(
        'There is already a personal workflow "mine".',
      );
      expect(() => createWorkflow("mine", TWO, "x", ctx, { personal: true })).toThrow(ConfigError);
      expect(() => createWorkflow("a b", ONE, "x", ctx)).toThrow('"a b" cannot be a workflow name');
      expect(() => createWorkflow("../up", ONE, "x", ctx)).toThrow("cannot be a workflow name");
      expect(text("project", "feature")).toBe(ONE);
      expect(text("user", "mine")).toBe(ONE);
      expect(places()).toHaveLength(2);
    });

    test("is refused for a text that is not a valid workflow, and writes nothing", () => {
      expect(() => createWorkflow("broken", '[steps.a]\nrole = "x"\n', "x", ctx)).toThrow(
        WorkflowError,
      );
      expect(() => createWorkflow("broken", "[steps", "x", ctx, { personal: true })).toThrow(
        "invalid TOML",
      );
      expect(existsSync(file("project", "broken"))).toBe(false);
      expect(existsSync(file("user", "broken"))).toBe(false);
      expect(existsSync(historyDir("project", "broken"))).toBe(false);
      expect(existsSync(historyDir("user", "broken"))).toBe(false);
      expect(places()).toEqual([]);
    });
  });

  describe("saveWorkflowText", () => {
    test("writes the file and records a version", () => {
      createWorkflow("feature", ONE, "workflow new", ctx);
      const version = saveWorkflowText(
        "feature",
        TWO,
        "designer",
        ctx,
        new Date(1_700_000_000_000),
      );
      expect(version).toMatchObject({
        n: 2,
        source: "designer",
        from: 1,
        time: "2023-11-14T22:13:20.000Z",
      });
      expect(text("project", "feature")).toBe(TWO);
      const history = workflowHistory("feature", ctx);
      expect(readHistory(history).current).toBe(2);
      expect(versionText(history, 1)).toBe(ONE);
      expect(versionText(history, 2)).toBe(TWO);
      // The same text again is no new version.
      expect(saveWorkflowText("feature", TWO, "designer", ctx).n).toBe(2);
      expect(sources("feature")).toEqual(["workflow new", "designer"]);
    });

    test("refuses a text that is not a valid workflow and writes nothing", () => {
      createWorkflow("feature", ONE, "workflow new", ctx);
      const broken = '[steps.a]\nprompt = "{{steps.b.result}}"\n';
      expect(() => saveWorkflowText("feature", broken, "designer", ctx)).toThrow(WorkflowError);
      expect(() => saveWorkflowText("feature", broken, "designer", ctx)).toThrow(
        `${file("project", "feature")}: step "a" uses the result of "b"`,
      );
      expect(() => saveWorkflowText("feature", "[steps", "designer", ctx)).toThrow("invalid TOML");
      expect(text("project", "feature")).toBe(ONE);
      expect(sources("feature")).toEqual(["workflow new"]);
      expect(existsSync(join(historyDir("project", "feature"), "v2.toml"))).toBe(false);
      expect(() => saveWorkflowText("nope", ONE, "designer", ctx)).toThrow(
        'Unknown workflow "nope".',
      );
      expect(existsSync(file("project", "nope"))).toBe(false);
    });

    test("a change made by hand before the save becomes a version of its own", () => {
      createWorkflow("feature", ONE, "workflow new", ctx);
      const edited = `# a note\n${ONE}`;
      byHand("project", "feature", edited);
      const version = saveWorkflowText("feature", TWO, "designer", ctx);
      expect(version).toMatchObject({ n: 3, from: 2 });
      expect(sources("feature")).toEqual(["workflow new", "edited by hand", "designer"]);
      expect(versionText(workflowHistory("feature", ctx), 2)).toBe(edited);
    });

    test("a file dwa has not seen yet gets its first version before the save", () => {
      byHand("project", "old", ONE);
      saveWorkflowText("old", TWO, "designer", ctx);
      expect(sources("old")).toEqual(["first version", "designer"]);
      expect(versionText(workflowHistory("old", ctx), 1)).toBe(ONE);
    });

    test("a hidden personal workflow is saved by its place; the project's stays as it is", () => {
      createWorkflow("feature", ONE, "workflow new", ctx);
      byHand("user", "feature", ONE);
      const ref = { name: "feature", source: "user" as const };
      expect(requireWorkflow(ref, ctx).hidden).toBe(true);
      saveWorkflowText(ref, TWO, "designer", ctx);
      expect(text("user", "feature")).toBe(TWO);
      expect(text("project", "feature")).toBe(ONE);
      expect(sources(ref)).toEqual(["first version", "designer"]);
      expect(sources("feature")).toEqual(["workflow new"]);
      expect(existsSync(join(historyDir("user", "feature"), "v2.toml"))).toBe(true);
      expect(existsSync(join(historyDir("project", "feature"), "v2.toml"))).toBe(false);
    });
  });

  describe("duplicateWorkflow", () => {
    test("copies next to the original when no place is named", () => {
      createWorkflow("feature", TWO, "x", ctx);
      createWorkflow("mine", ONE, "x", ctx, { personal: true });
      const copy = duplicateWorkflow("feature", "feature-2", ctx);
      expect(copy).toMatchObject({ source: "project", path: file("project", "feature-2") });
      expect(text("project", "feature-2")).toBe(TWO);
      expect(sources("feature-2")).toEqual(["copy of feature"]);
      const own = duplicateWorkflow("mine", "mine-2", ctx);
      expect(own.source).toBe("user");
      expect(text("user", "mine-2")).toBe(ONE);
      expect(existsSync(join(historyDir("user", "mine-2"), "v1.toml"))).toBe(true);
      // The originals are as they were.
      expect(text("project", "feature")).toBe(TWO);
      expect(sources("feature")).toEqual(["x"]);
    });

    test("copies into the other place when that is named", () => {
      createWorkflow("feature", TWO, "x", ctx);
      createWorkflow("mine", ONE, "x", ctx, { personal: true });
      expect(duplicateWorkflow("feature", "kept", ctx, { personal: true }).path).toBe(
        file("user", "kept"),
      );
      expect(text("user", "kept")).toBe(TWO);
      expect(duplicateWorkflow("mine", "shared", ctx, { personal: false }).path).toBe(
        file("project", "shared"),
      );
      expect(text("project", "shared")).toBe(ONE);
      expect(() => duplicateWorkflow("feature", "mine", ctx)).toThrow(
        'There is already a personal workflow "mine".',
      );
      expect(() => duplicateWorkflow("nope", "other", ctx)).toThrow('Unknown workflow "nope".');
    });
  });

  describe("renameWorkflow", () => {
    test("renames the file and its history moves with it", () => {
      createWorkflow("feature", ONE, "workflow new", ctx);
      saveWorkflowText("feature", TWO, "designer", ctx);
      const renamed = renameWorkflow("feature", "ship", ctx);
      expect(renamed).toEqual({
        name: "ship",
        source: "project",
        path: file("project", "ship"),
        hidden: false,
      });
      expect(existsSync(file("project", "feature"))).toBe(false);
      expect(text("project", "ship")).toBe(TWO);
      expect(existsSync(historyDir("project", "feature"))).toBe(false);
      expect(sources("ship")).toEqual(["workflow new", "designer"]);
      expect(versionText(workflowHistory("ship", ctx), 1)).toBe(ONE);
      expect(findWorkflow("feature", ctx)).toBeNull();
    });

    test("records a change made by hand first, and stays in the personal folder", () => {
      createWorkflow("mine", ONE, "workflow new", ctx, { personal: true });
      byHand("user", "mine", TWO);
      const renamed = renameWorkflow("mine", "own", ctx);
      expect(renamed.source).toBe("user");
      expect(text("user", "own")).toBe(TWO);
      expect(existsSync(historyDir("user", "mine"))).toBe(false);
      expect(sources("own")).toEqual(["workflow new", "edited by hand"]);
      expect(existsSync(historyDir("project", "own"))).toBe(false);
    });

    test("is refused for a name taken in either place, and nothing moves", () => {
      createWorkflow("feature", ONE, "x", ctx);
      createWorkflow("mine", TWO, "x", ctx, { personal: true });
      expect(() => renameWorkflow("feature", "mine", ctx)).toThrow(
        'There is already a personal workflow "mine".',
      );
      expect(() => renameWorkflow("mine", "feature", ctx)).toThrow(
        'There is already a workflow "feature".',
      );
      expect(() => renameWorkflow("feature", "a b", ctx)).toThrow("cannot be a workflow name");
      expect(text("project", "feature")).toBe(ONE);
      expect(text("user", "mine")).toBe(TWO);
      expect(sources("feature")).toEqual(["x"]);
    });
  });

  describe("moveWorkflow", () => {
    test("moves a file to the other place with its history; the name still finds it", () => {
      createWorkflow("feature", ONE, "workflow new", ctx);
      saveWorkflowText("feature", TWO, "designer", ctx);
      const moved = moveWorkflow("feature", "user", ctx);
      expect(moved).toEqual({
        name: "feature",
        source: "user",
        path: file("user", "feature"),
        hidden: false,
      });
      expect(existsSync(file("project", "feature"))).toBe(false);
      expect(existsSync(historyDir("project", "feature"))).toBe(false);
      expect(text("user", "feature")).toBe(TWO);
      expect(sources("feature")).toEqual(["workflow new", "designer"]);
      expect(existsSync(join(historyDir("user", "feature"), "v2.toml"))).toBe(true);
      expect(findWorkflow("feature", ctx)?.source).toBe("user");

      const back = moveWorkflow("feature", "project", ctx);
      expect(back.path).toBe(file("project", "feature"));
      expect(sources("feature")).toEqual(["workflow new", "designer"]);
      expect(existsSync(historyDir("user", "feature"))).toBe(false);
    });

    test("is refused when the file is there already or the other place has one of the name", () => {
      createWorkflow("feature", ONE, "x", ctx);
      byHand("user", "feature", TWO);
      expect(() => moveWorkflow("feature", "project", ctx)).toThrow(
        'workflow "feature" is already in the project.',
      );
      expect(() => moveWorkflow("feature", "user", ctx)).toThrow(
        'There is already a personal workflow "feature"; rename one of them first.',
      );
      expect(() => moveWorkflow({ name: "feature", source: "user" }, "project", ctx)).toThrow(
        'There is already a project workflow "feature"',
      );
      expect(text("project", "feature")).toBe(ONE);
      expect(text("user", "feature")).toBe(TWO);
    });
  });

  describe("deleteWorkflow", () => {
    test("deletes the file and keeps its history, a last change by hand included", () => {
      createWorkflow("feature", ONE, "workflow new", ctx);
      byHand("project", "feature", TWO);
      deleteWorkflow("feature", ctx);
      expect(existsSync(file("project", "feature"))).toBe(false);
      expect(findWorkflow("feature", ctx)).toBeNull();
      const kept = historyDir("project", "feature");
      expect(readFileSync(join(kept, "v1.toml"), "utf8")).toBe(ONE);
      expect(readFileSync(join(kept, "v2.toml"), "utf8")).toBe(TWO);
      expect(() => deleteWorkflow("feature", ctx)).toThrow('Unknown workflow "feature".');
    });

    test("deletes the file that is named: the project's, or the hidden personal one", () => {
      createWorkflow("feature", ONE, "x", ctx);
      byHand("user", "feature", TWO);
      deleteWorkflow({ name: "feature", source: "user" }, ctx);
      expect(places()).toEqual([["feature", "project", false]]);
      expect(existsSync(join(historyDir("user", "feature"), "v1.toml"))).toBe(true);
      byHand("user", "feature", TWO);
      deleteWorkflow("feature", ctx);
      expect(places()).toEqual([["feature", "user", false]]);
    });
  });

  describe("switchWorkflow", () => {
    test("gives the file the content of a version and moves the pointer only", () => {
      createWorkflow("feature", ONE, "workflow new", ctx);
      saveWorkflowText("feature", TWO, "designer", ctx);
      expect(switchWorkflow("feature", 1, ctx)).toMatchObject({ n: 1, source: "workflow new" });
      expect(text("project", "feature")).toBe(ONE);
      const history = readHistory(workflowHistory("feature", ctx));
      expect(history.current).toBe(1);
      expect(history.versions.map((version) => version.n)).toEqual([1, 2]);
      switchWorkflow("feature", 2, ctx);
      expect(text("project", "feature")).toBe(TWO);
      expect(() => switchWorkflow("feature", 9, ctx)).toThrow("There is no version v9.");
    });

    test("refuses a version that is no longer a valid workflow", () => {
      createWorkflow("feature", ONE, "workflow new", ctx);
      // Saved by hand while broken, and noticed: history keeps what was there, valid or not.
      byHand("project", "feature", '[steps.a]\nrole = "x"\n');
      noticeWorkflowEdits(ctx);
      byHand("project", "feature", TWO);
      noticeWorkflowEdits(ctx);
      expect(sources("feature")).toEqual(["workflow new", "edited by hand", "edited by hand"]);
      expect(() => switchWorkflow("feature", 2, ctx)).toThrow(WorkflowError);
      expect(() => switchWorkflow("feature", 2, ctx)).toThrow(/^v2: steps\.a\.prompt/);
      expect(text("project", "feature")).toBe(TWO);
      expect(readHistory(workflowHistory("feature", ctx)).current).toBe(3);
    });
  });

  describe("noticeWorkflowEdits", () => {
    test("gives every file its version, in both places, and only when it changed", () => {
      byHand("project", "feature", ONE);
      byHand("user", "feature", TWO);
      byHand("user", "mine", ONE);
      byHand("project", "broken", "[steps");
      noticeWorkflowEdits(ctx);
      noticeWorkflowEdits(ctx);
      expect(sources("feature")).toEqual(["first version"]);
      expect(sources({ name: "feature", source: "user" })).toEqual(["first version"]);
      expect(sources("mine")).toEqual(["first version"]);
      // A file that is not a workflow at the moment is still a file with a history.
      expect(sources("broken")).toEqual(["first version"]);
      expect(existsSync(join(historyDir("user", "mine"), "v1.toml"))).toBe(true);
      expect(existsSync(historyDir("project", "mine"))).toBe(false);

      byHand("project", "feature", TWO);
      byHand("user", "feature", ONE);
      noticeWorkflowEdits(ctx);
      noticeWorkflowEdits(ctx);
      expect(sources("feature")).toEqual(["first version", "edited by hand"]);
      expect(sources({ name: "feature", source: "user" })).toEqual([
        "first version",
        "edited by hand",
      ]);
      expect(sources("mine")).toEqual(["first version"]);
      // Going back to an earlier content by hand moves the pointer and adds nothing.
      byHand("project", "feature", ONE);
      noticeWorkflowEdits(ctx);
      const history = readHistory(workflowHistory("feature", ctx));
      expect(history.current).toBe(1);
      expect(history.versions).toHaveLength(2);
    });

    test("does nothing in a project without workflows", () => {
      expect(() => noticeWorkflowEdits(ctx)).not.toThrow();
      expect(existsSync(join(dir, ".dwa"))).toBe(false);
      expect(existsSync(join(dir, "home"))).toBe(false);
    });
  });

  describe("workflowWarnings", () => {
    test("a personal workflow: other projects are not checked", () => {
      byHand("user", "mine", ONE);
      const other = ['Other projects that use your personal workflow "mine" are not checked.'];
      expect(workflowWarnings("rename", "mine", ctx)).toEqual(other);
      expect(workflowWarnings("delete", "mine", ctx)).toEqual(other);
      expect(workflowWarnings("move", "mine", ctx)).toEqual([
        'Other projects that use your personal workflow "mine" are not checked. ' +
          "Its steps name roles; the project needs them too.",
      ]);
    });

    test("a project workflow: others lose it on a move, and a hidden twin comes forward", () => {
      byHand("project", "feature", ONE);
      byHand("project", "alone", ONE);
      byHand("user", "feature", TWO);
      const twin = [
        'Your personal workflow "feature" is hidden by this one and will be the one used here afterwards.',
      ];
      expect(workflowWarnings("rename", "feature", ctx)).toEqual(twin);
      expect(workflowWarnings("delete", "feature", ctx)).toEqual(twin);
      expect(workflowWarnings("move", "feature", ctx)).toEqual([
        'Others who use this project will no longer have workflow "feature".',
      ]);
      expect(workflowWarnings("rename", "alone", ctx)).toEqual([]);
      expect(workflowWarnings("delete", "alone", ctx)).toEqual([]);
      expect(workflowWarnings("delete", { name: "feature", source: "user" }, ctx)).toEqual([
        'Other projects that use your personal workflow "feature" are not checked.',
      ]);
      expect(() => workflowWarnings("delete", "nope", ctx)).toThrow('Unknown workflow "nope".');
    });
  });

  describe("roles in workflows", () => {
    const STEPS =
      '# keep me\n[steps.a]\nrole = "explore" # reads\nprompt = "a"\n\n' +
      '[steps.b]\nrole = "developer"\ndepends_on = ["a"]\nprompt = "role = explore"\n\n' +
      '[steps.c]\nrole = "explore"\ndepends_on = ["b"]\nprompt = "c"\n';

    test("roleMentions names the steps that run as a role, and whose workflow it is", () => {
      byHand("project", "feature", STEPS);
      byHand("user", "mine", '[steps.only]\nrole = "explore"\nprompt = "x"\n');
      // Hidden by the project's file: nothing here runs it.
      byHand("user", "feature", '[steps.hidden]\nrole = "explore"\nprompt = "x"\n');
      // Not TOML at the moment: left to `config check`.
      byHand("project", "broken", '[steps.a\nrole = "explore"\n');
      expect(roleMentions("explore", ctx)).toEqual([
        { workflow: "feature", step: "a", personal: false },
        { workflow: "feature", step: "c", personal: false },
        { workflow: "mine", step: "only", personal: true },
      ]);
      expect(roleMentions("developer", ctx)).toEqual([
        { workflow: "feature", step: "b", personal: false },
      ]);
      expect(roleMentions("reviewer", ctx)).toEqual([]);
    });

    test("followRoleRename changes the files in place and records a version of each", () => {
      byHand("project", "feature", STEPS);
      byHand("project", "other", ONE);
      byHand("user", "mine", '[steps.only]\nrole = "explore"\nprompt = "x"\n');
      noticeWorkflowEdits(ctx);
      followRoleRename("explore", "scout", ctx);
      expect(text("project", "feature")).toBe(
        '# keep me\n[steps.a]\nrole = "scout" # reads\nprompt = "a"\n\n' +
          '[steps.b]\nrole = "developer"\ndepends_on = ["a"]\nprompt = "role = explore"\n\n' +
          '[steps.c]\nrole = "scout"\ndepends_on = ["b"]\nprompt = "c"\n',
      );
      expect(text("user", "mine")).toBe('[steps.only]\nrole = "scout"\nprompt = "x"\n');
      expect(sources("feature")).toEqual(["first version", "role explore renamed to scout"]);
      expect(sources("mine")).toEqual(["first version", "role explore renamed to scout"]);
      expect(versionText(workflowHistory("feature", ctx), 1)).toBe(STEPS);
      expect(existsSync(join(historyDir("user", "mine"), "v2.toml"))).toBe(true);
      // A workflow that does not name the role is not written again.
      expect(text("project", "other")).toBe(ONE);
      expect(sources("other")).toEqual(["first version"]);
      expect(roleMentions("explore", ctx)).toEqual([]);
    });

    test("followRoleRename records the file as it was when dwa had not seen it yet", () => {
      byHand("project", "feature", STEPS);
      followRoleRename("explore", "scout", ctx);
      expect(sources("feature")).toEqual(["first version", "role explore renamed to scout"]);
      expect(versionText(workflowHistory("feature", ctx), 1)).toBe(STEPS);
    });

    test("followRoleRename leaves a hidden personal workflow alone", () => {
      const hidden = '[steps.hidden]\nrole = "explore"\nprompt = "x"\n';
      byHand("project", "feature", STEPS);
      byHand("user", "feature", hidden);
      noticeWorkflowEdits(ctx);
      followRoleRename("explore", "scout", ctx);
      expect(text("project", "feature")).toContain('role = "scout" # reads');
      expect(text("user", "feature")).toBe(hidden);
      expect(sources({ name: "feature", source: "user" })).toEqual(["first version"]);
    });
  });
});
