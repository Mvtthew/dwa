// The workflow designer without a screen: changes, taking them back, and what a text shows as.
import { describe, expect, test } from "bun:test";
import { MARKS } from "../src/shared/diagram.ts";
import {
  apply,
  applyMore,
  type DesignTarget,
  dirty,
  freeStepName,
  linkOp,
  newSession,
  type Op,
  redo,
  type Session,
  UNDO_LIMIT,
  undo,
  view,
} from "../src/ui/designer-model.ts";

const TEXT = `# The team's usual way.
description = "Explore, build, review"

[steps.explore]
role = "explore"
prompt = "Look around: {{input}}"

[steps.build]
role = "developer"
depends_on = ["explore"]
prompt = "Build it: {{steps.explore.result}}"

[steps.review]
role = "reviewer"
depends_on = ["build"]
reviews = "build"
prompt = "Review it"
`;

const target: DesignTarget = { kind: "file", name: "feature", source: "project" };
const start = () => newSession(target, TEXT);
/** Each step with what it waits for, in file order. */
const shape = (session: Session) =>
  view(session.text, "feature").steps.map((step) => `${step.id}<-${step.dependsOn.join(",")}`);
const all = (session: Session, ...ops: Op[]) => ops.reduce(apply, session);

describe("a designer session", () => {
  test("starts clean, with nothing to take back and nothing selected", () => {
    const session = start();
    expect(session).toMatchObject({ target, base: TEXT, text: TEXT, selected: null });
    expect(dirty(session)).toBe(false);
    expect(undo(session)).toBe(session);
    expect(redo(session)).toBe(session);
  });

  test("a new step goes under the step named, is selected, and leaves the rest of the text", () => {
    const session = apply(start(), {
      op: "addStep",
      id: "test",
      fields: { role: "developer" },
      below: "build",
    });
    expect(shape(session)).toContain("test<-build");
    expect(session.selected).toEqual({ kind: "step", id: "test" });
    expect(session.text).toContain("# The team's usual way.");
    expect(dirty(session)).toBe(true);
    // Without a place it depends on nothing.
    const loose = apply(start(), { op: "addStep", id: "alone", fields: {} });
    expect(shape(loose)).toContain("alone<-");
  });

  test("every kind of change is made on the text", () => {
    let session = all(
      start(),
      { op: "setFields", id: "build", changes: { model: "opus", role: null } },
      { op: "setDescription", description: "Another" },
      { op: "connect", from: "explore", to: "review" },
    );
    let design = view(session.text, "feature");
    expect(design.description).toBe("Another");
    expect(design.steps[1]?.fields).toMatchObject({ model: "opus" });
    expect(design.steps[1]?.fields.role).toBeUndefined();
    expect(shape(session)).toEqual(["explore<-", "build<-explore", "review<-build,explore"]);

    session = all(
      session,
      { op: "disconnect", from: "explore", to: "review" },
      { op: "clearReview", reviewer: "review" },
    );
    design = view(session.text, "feature");
    expect(shape(session)).toEqual(["explore<-", "build<-explore", "review<-build"]);
    expect(design.steps[2]?.reviews).toBeUndefined();

    session = apply(session, { op: "makeReview", reviewer: "review", target: "build", rounds: 5 });
    expect(view(session.text, "feature").steps[2]).toMatchObject({
      reviews: "build",
      fields: { max_rounds: 5 },
    });

    session = apply(session, { op: "replaceText", text: TEXT });
    expect(session.text).toBe(TEXT);
    expect(dirty(session)).toBe(false);
    // The way there can still be taken back.
    expect(session.undo.length).toBeGreaterThan(0);
  });

  test("a review of a step it does not follow yet also waits for it", () => {
    const session = all(
      start(),
      { op: "addStep", id: "check", fields: {} },
      { op: "makeReview", reviewer: "check", target: "explore" },
    );
    expect(view(session.text, "feature").steps.find((step) => step.id === "check")).toMatchObject({
      dependsOn: ["explore"],
      reviews: "explore",
    });
  });

  test("removing a step joins what followed it to what came before, and the cursor lets go", () => {
    const selected = { ...start(), selected: { kind: "step", id: "build" } as const };
    const session = apply(selected, { op: "removeStep", id: "build" });
    expect(shape(session)).toEqual(["explore<-", "review<-explore"]);
    expect(session.selected).toBeNull();
  });

  test("the cursor stays on a step or a line that is still there", () => {
    const onStep = { ...start(), selected: { kind: "step", id: "explore" } as const };
    expect(apply(onStep, { op: "removeStep", id: "review" }).selected).toEqual({
      kind: "step",
      id: "explore",
    });
    const onLine = {
      ...start(),
      selected: { kind: "edge", from: "explore", to: "build" } as const,
    };
    expect(apply(onLine, { op: "setDescription", description: "x" }).selected).toEqual({
      kind: "edge",
      from: "explore",
      to: "build",
    });
    expect(apply(onLine, { op: "removeStep", id: "build" }).selected).toBeNull();
    // A place to put a step down is gone once something changed.
    const onSlot = { ...start(), selected: { kind: "slot", index: 0 } as const };
    expect(apply(onSlot, { op: "setDescription", description: "x" }).selected).toBeNull();
  });

  test("a rename is followed through the text, selects the step and is remembered", () => {
    let session = apply(start(), { op: "renameStep", from: "build", to: "make" });
    expect(shape(session)).toEqual(["explore<-", "make<-explore", "review<-make"]);
    expect(view(session.text, "feature").steps[2]?.reviews).toBe("make");
    expect(session.selected).toEqual({ kind: "step", id: "make" });
    expect(session.renames).toEqual({ build: "make" });
    // A second rename is counted from the name the step had at the start.
    session = apply(session, { op: "renameStep", from: "make", to: "code" });
    expect(session.renames).toEqual({ build: "code" });
    session = apply(session, { op: "renameStep", from: "explore", to: "look" });
    expect(session.renames).toEqual({ build: "code", explore: "look" });
    // Back to its first name: no longer renamed.
    session = apply(session, { op: "renameStep", from: "code", to: "build" });
    expect(session.renames).toEqual({ explore: "look" });
  });

  // DEFECT (src/ui/designer-model.ts, `undo` and `redo`): they put the text back but
  // leave `renames` as it was, so after undoing a rename the session still says the step was
  // renamed (`{ build: "make" }`) although the text has `build` again. `renames` is what lets a
  // file follow a run's renames (`conform` in src/shared/workflow-edit.ts), so a stale entry
  // would rename a step that was never renamed. `replaceText` has the same effect: it can bring
  // the old name back without `renames` noticing.
  test("taking a rename back forgets it", () => {
    const renamed = apply(start(), { op: "renameStep", from: "build", to: "make" });
    const back = undo(renamed);
    expect(back.text).toBe(TEXT);
    expect(back.renames).toEqual({});
    expect(redo(back).renames).toEqual({ build: "make" });
  });

  test("a change that changes nothing leaves the session as it is", () => {
    const session = start();
    expect(apply(session, { op: "connect", from: "explore", to: "build" })).toBe(session);
    expect(apply(session, { op: "replaceText", text: TEXT })).toBe(session);
    expect(applyMore(session, { op: "disconnect", from: "explore", to: "review" })).toBe(session);
  });

  test("a change that cannot be made throws with the reason", () => {
    const session = start();
    expect(() => apply(session, { op: "connect", from: "review", to: "explore" })).toThrow("loop");
    expect(() => apply(session, { op: "renameStep", from: "build", to: "review" })).toThrow(
      'There is already a step "review".',
    );
    expect(() => apply(session, { op: "addStep", id: "build", fields: {} })).toThrow(
      'There is already a step "build".',
    );
    expect(() => apply(session, { op: "addStep", id: "not a name", fields: {} })).toThrow(
      "cannot be a step name",
    );
    expect(() => apply(session, { op: "removeStep", id: "nobody" })).toThrow(
      'There is no step "nobody".',
    );
    expect(session.text).toBe(TEXT);
    expect(session.undo).toEqual([]);
  });

  test("dropping a step puts it on a line, beside a step or below one, and selects it", () => {
    const more = apply(start(), { op: "addStep", id: "test", fields: {} });
    const onLine = apply(more, {
      op: "drop",
      id: "test",
      slot: { kind: "edge", from: "explore", to: "build" },
    });
    expect(shape(onLine)).toEqual(["explore<-", "test<-explore", "build<-test", "review<-build"]);
    expect(onLine.selected).toEqual({ kind: "step", id: "test" });

    const beside = apply(more, { op: "drop", id: "test", slot: { kind: "beside", step: "build" } });
    expect(shape(beside)).toEqual([
      "explore<-",
      "build<-explore",
      "test<-explore",
      "review<-build",
    ]);

    const below = apply(more, { op: "drop", id: "test", slot: { kind: "below", step: "review" } });
    expect(shape(below).at(-1)).toBe("test<-review");

    // A step that is moved away leaves the chain whole.
    const moved = apply(start(), {
      op: "drop",
      id: "build",
      slot: { kind: "below", step: "review" },
    });
    expect(shape(moved)).toEqual(["explore<-", "review<-explore", "build<-review"]);
  });
});

describe("undo and redo", () => {
  test("take changes back one at a time and make them again", () => {
    const one = apply(start(), { op: "setDescription", description: "One" });
    const two = apply(one, { op: "removeStep", id: "review" });
    expect(two.undo).toHaveLength(2);

    const back = undo(two);
    expect(back.text).toBe(one.text);
    expect(undo(back).text).toBe(TEXT);
    expect(dirty(undo(back))).toBe(false);
    const first = undo(back);
    expect(undo(first)).toBe(first);

    const again = redo(redo(undo(back)));
    expect(again.text).toBe(two.text);
    expect(again.redo).toEqual([]);
    expect(redo(again)).toBe(again);
  });

  test("a new change after an undo drops what was taken back", () => {
    const back = undo(apply(start(), { op: "setDescription", description: "One" }));
    expect(back.redo).toHaveLength(1);
    const other = apply(back, { op: "setDescription", description: "Two" });
    expect(other.redo).toEqual([]);
    expect(redo(other)).toBe(other);
    expect(undo(other).text).toBe(TEXT);
  });

  test("the cursor lets go of a step that an undo takes away", () => {
    const added = apply(start(), { op: "addStep", id: "test", fields: {}, below: "build" });
    expect(added.selected).toEqual({ kind: "step", id: "test" });
    expect(undo(added).selected).toBeNull();
    const kept = { ...added, selected: { kind: "step", id: "build" } as const };
    expect(undo(kept).selected).toEqual({ kind: "step", id: "build" });
  });

  test("typing that goes on from a change is taken back as one piece", () => {
    const prompt = (text: string): Op => ({
      op: "setFields",
      id: "build",
      changes: { prompt: text },
    });
    let session = apply(start(), prompt("B"));
    for (const typed of ["Bu", "Bui", "Buil", "Build"]) session = applyMore(session, prompt(typed));
    expect(view(session.text, "feature").steps[1]?.fields.prompt).toBe("Build");
    expect(session.undo).toHaveLength(1);
    const back = undo(session);
    expect(back.text).toBe(TEXT);
    expect(view(redo(back).text, "feature").steps[1]?.fields.prompt).toBe("Build");
  });

  test("going on from a change still drops what was taken back", () => {
    const back = undo(apply(start(), { op: "setDescription", description: "One" }));
    const typed = applyMore(apply(back, { op: "setDescription", description: "T" }), {
      op: "setDescription",
      description: "Tw",
    });
    expect(typed.redo).toEqual([]);
    expect(typed.undo).toEqual([TEXT]);
  });

  test(`keeps the last ${UNDO_LIMIT} states only`, () => {
    let session = start();
    const texts: string[] = [];
    for (let i = 0; i < UNDO_LIMIT + 5; i++) {
      texts.push(session.text);
      session = apply(session, { op: "setDescription", description: `Change ${i}` });
    }
    expect(session.undo).toHaveLength(UNDO_LIMIT);
    let back = session;
    for (let i = 0; i < UNDO_LIMIT + 5; i++) back = undo(back);
    // The five oldest states are gone; the oldest one kept is the sixth.
    expect(back.text).toBe(texts[5] as string);
    expect(back.undo).toEqual([]);
    expect(back.redo).toHaveLength(UNDO_LIMIT);
  });
});

describe("what a text shows as", () => {
  test("a valid workflow: steps in file order, what comes before each, and the picture's input", () => {
    const design = view(TEXT, "feature");
    expect(design.problems).toEqual([]);
    expect(design.definition?.name).toBe("feature");
    expect(design.description).toBe("Explore, build, review");
    expect(design.steps.map((step) => step.id)).toEqual(["explore", "build", "review"]);
    expect(design.steps[2]).toMatchObject({ dependsOn: ["build"], reviews: "build", problems: [] });
    expect(design.ancestors.explore).toEqual([]);
    expect(design.ancestors.build).toEqual(["explore"]);
    expect([...(design.ancestors.review ?? [])].sort()).toEqual(["build", "explore"]);
    expect(design.input.steps).toEqual([
      { id: "explore", dependsOn: [], detail: "explore" },
      { id: "build", dependsOn: ["explore"], detail: "developer" },
      { id: "review", dependsOn: ["build"], reviews: "build", detail: "reviewer" },
    ]);
  });

  test("marks a step that keeps its agent, has settings of its own or review passes", () => {
    const text = `[steps.a]
keep_agent = true
model = "opus"
prompt = "x"

[steps.b]
depends_on = ["a"]
reviews = "a"
max_rounds = 4
keep_agent = true
prompt = "y"

[steps.c]
depends_on = ["b"]
tools = ["Read"]
prompt = "z"
`;
    const design = view(text, "w");
    expect(design.problems).toEqual([]);
    expect(design.description).toBe("");
    expect(design.input.steps).toMatchObject([
      { id: "a", detail: "no role", note: `${MARKS.keepsAgent}${MARKS.ownSettings}` },
      { id: "b", rounds: 4, note: MARKS.keepsAgent },
      { id: "c", note: MARKS.ownSettings },
    ]);
  });

  test("a text that fails the schema is still drawn, with the problems at their steps", () => {
    const text = `description = "Half done"

[steps.explore]
role = 5
prompt = "Look"

[steps.build]
depends_on = ["explore"]
`;
    const design = view(text, "draft");
    expect(design.definition).toBeNull();
    expect(design.problems.length).toBeGreaterThan(0);
    expect(design.description).toBe("Half done");
    expect(design.steps.map((step) => step.id)).toEqual(["explore", "build"]);
    expect(design.steps[0]?.problems).toMatchObject([{ step: "explore", key: "role" }]);
    expect(design.steps[1]?.problems).toMatchObject([{ step: "build", key: "prompt" }]);
    expect(design.ancestors.build).toEqual(["explore"]);
    expect(design.input.steps).toMatchObject([
      { id: "explore", dependsOn: [], detail: "no role", mark: MARKS.problem, tone: "bad" },
      { id: "build", dependsOn: ["explore"], detail: "no role", mark: MARKS.problem, tone: "bad" },
    ]);
  });

  test("a workflow that reads but does not hold together shows what is wrong where", () => {
    const text = `[steps.a]
depends_on = ["nobody"]
prompt = "x"

[steps.b]
prompt = "{{steps.a.result}}"
`;
    const design = view(text, "w");
    expect(design.definition).toBeNull();
    expect(design.steps[0]?.problems.map((problem) => problem.message)).toEqual([
      'step "a" depends on unknown step "nobody"',
    ]);
    expect(design.steps[1]?.problems.map((problem) => problem.message)).toEqual([
      'step "b" uses the result of "a" but does not depend on it',
    ]);
    expect(design.input.steps[0]).toMatchObject({ dependsOn: ["nobody"], mark: MARKS.problem });
  });

  test("steps that go round in a loop are drawn and do not hang", () => {
    const text = `[steps.a]
depends_on = ["b"]
prompt = "x"

[steps.b]
depends_on = ["a"]
prompt = "y"
`;
    const design = view(text, "w");
    expect(design.definition).toBeNull();
    expect(design.problems.length).toBeGreaterThan(0);
    expect(design.steps.map((step) => step.id)).toEqual(["a", "b"]);
    expect([...(design.ancestors.a ?? [])].sort()).toEqual(["a", "b"]);
  });

  test("a text that is not TOML shows nothing but why", () => {
    const design = view("[steps.a\nprompt = ", "w");
    expect(design.steps).toEqual([]);
    expect(design.input.steps).toEqual([]);
    expect(design.definition).toBeNull();
    expect(design.description).toBe("");
    expect(design.problems).toHaveLength(1);
    expect(design.problems[0]?.message).toContain("invalid TOML");
  });

  test("an empty text, which a new workflow starts as, has no steps and one problem", () => {
    const design = view("", "w");
    expect(design.steps).toEqual([]);
    expect(design.input.steps).toEqual([]);
    expect(design.definition).toBeNull();
    expect(design.problems).toHaveLength(1);
    expect(design.problems[0]?.step).toBeUndefined();
    expect(view("[steps]\n", "w").problems.map((problem) => problem.message)).toEqual([
      "a workflow needs at least one step",
    ]);
  });
});

describe("joining two steps", () => {
  const design = view(TEXT, "feature");
  const layers = { explore: 0, build: 1, review: 2 };

  test("down to a later step makes that step wait for this one", () => {
    expect(linkOp(design, layers, "explore", "review")).toEqual({
      op: "connect",
      from: "explore",
      to: "review",
    });
  });

  test("up to an earlier step makes this one its review", () => {
    expect(linkOp(design, layers, "review", "explore")).toEqual({
      op: "makeReview",
      reviewer: "review",
      target: "explore",
    });
    // A step it already follows is reviewed whatever the rows say.
    expect(linkOp(design, {}, "build", "explore")).toEqual({
      op: "makeReview",
      reviewer: "build",
      target: "explore",
    });
  });

  test("two steps on one row are joined as a dependency, and a step is not joined to itself", () => {
    const side = view(
      `${TEXT}\n[steps.docs]\ndepends_on = ["explore"]\nprompt = "Write"\n`,
      "feature",
    );
    expect(linkOp(side, { ...layers, docs: 1 }, "build", "docs")).toEqual({
      op: "connect",
      from: "build",
      to: "docs",
    });
    expect(linkOp(design, layers, "build", "build")).toBeNull();
  });
});

describe("a name for a new step", () => {
  test("is the wanted one when it is free, else the first numbered one that is", () => {
    const design = view(TEXT, "feature");
    expect(freeStepName(design)).toBe("step");
    expect(freeStepName(design, "build")).toBe("build-2");
    const taken = view(
      `${TEXT}\n[steps.step]\nprompt = "a"\n\n[steps.step-2]\nprompt = "b"\n`,
      "feature",
    );
    expect(freeStepName(taken)).toBe("step-3");
    expect(freeStepName(view("", "empty"))).toBe("step");
  });
});
