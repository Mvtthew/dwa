// What a drag on the picture means: the change it asks for, and what that change does.
import { describe, expect, test } from "bun:test";
import { layoutDiagram, type Region, type Slot } from "../src/shared/diagram.ts";
import { gesture, layersOf } from "../src/ui/designer-gesture.ts";
import { apply, newSession, view } from "../src/ui/designer-model.ts";

const TEXT = `[steps.explore]
prompt = "Look"

[steps.build]
depends_on = ["explore"]
prompt = "Build"

[steps.docs]
depends_on = ["explore"]
prompt = "Write"

[steps.review]
depends_on = ["build", "docs"]
prompt = "Review"

[steps.extra]
prompt = "More"
`;

const design = view(TEXT, "w");
const step = (id: string): Region => ({ kind: "step", id });
/** The picture while `id` is carried, and where one of its marked places is. */
function carrying(id: string) {
  const diagram = layoutDiagram(design.input, { carrying: id });
  const slot = (wanted: Slot): Region => {
    const index = diagram.slots.findIndex(
      (entry) => JSON.stringify(entry.slot) === JSON.stringify(wanted),
    );
    if (index === -1) {
      throw new Error(`no place ${JSON.stringify(wanted)} in ${JSON.stringify(diagram.slots)}`);
    }
    return { kind: "slot", index };
  };
  return { diagram, slot };
}
/** The steps with what each waits for after the drag, in file order. */
function after(from: Region, to: Region, diagram = layoutDiagram(design.input)): string[] {
  const op = gesture(design, diagram, from, to);
  if (!op) throw new Error("the drag means nothing");
  const session = apply(newSession({ kind: "file", name: "w", source: "project" }, TEXT), op);
  return view(session.text, "w").steps.map((entry) => `${entry.id}<-${entry.dependsOn.join(",")}`);
}

describe("the rows of the picture", () => {
  test("every step has its row, the top one 0", () => {
    expect(layersOf(layoutDiagram(design.input))).toEqual({
      explore: 0,
      extra: 0,
      build: 1,
      docs: 1,
      review: 2,
    });
    expect(layersOf(layoutDiagram({ steps: [] }))).toEqual({});
  });
});

describe("a drag on the picture", () => {
  test("onto a line puts the step between the two it joins", () => {
    const { diagram, slot } = carrying("extra");
    const to = slot({ kind: "edge", from: "explore", to: "build" });
    expect(gesture(design, diagram, step("extra"), to)).toEqual({
      op: "drop",
      id: "extra",
      slot: { kind: "edge", from: "explore", to: "build" },
    });
    expect(after(step("extra"), to, diagram)).toEqual([
      "explore<-",
      "extra<-explore",
      "build<-extra",
      "docs<-explore",
      "review<-build,docs",
    ]);
  });

  test("beside a step makes it wait for what that step waits for", () => {
    const { diagram, slot } = carrying("extra");
    const to = slot({ kind: "beside", step: "build" });
    expect(gesture(design, diagram, step("extra"), to)).toEqual({
      op: "drop",
      id: "extra",
      slot: { kind: "beside", step: "build" },
    });
    expect(after(step("extra"), to, diagram)).toContain("extra<-explore");
    expect(after(step("extra"), to, diagram)).toContain("build<-explore");
  });

  test("below a step makes it wait for that step alone", () => {
    const { diagram, slot } = carrying("docs");
    const to = slot({ kind: "below", step: "review" });
    expect(gesture(design, diagram, step("docs"), to)).toEqual({
      op: "drop",
      id: "docs",
      slot: { kind: "below", step: "review" },
    });
    // Where it was taken from, the chain stays whole.
    expect(after(step("docs"), to, diagram)).toEqual([
      "explore<-",
      "build<-explore",
      "review<-build,explore",
      "docs<-review",
      "extra<-",
    ]);
  });

  test("down onto a later step makes that step depend on this one", () => {
    const diagram = layoutDiagram(design.input);
    expect(gesture(design, diagram, step("extra"), step("review"))).toEqual({
      op: "connect",
      from: "extra",
      to: "review",
    });
    expect(after(step("extra"), step("review"))).toContain("review<-build,docs,extra");
    // Along a row too.
    expect(gesture(design, diagram, step("build"), step("docs"))).toEqual({
      op: "connect",
      from: "build",
      to: "docs",
    });
  });

  test("up onto a step it follows makes this one its review", () => {
    const diagram = layoutDiagram(design.input);
    expect(gesture(design, diagram, step("review"), step("build"))).toEqual({
      op: "makeReview",
      reviewer: "review",
      target: "build",
    });
    expect(gesture(design, diagram, step("review"), step("explore"))).toEqual({
      op: "makeReview",
      reviewer: "review",
      target: "explore",
    });
    const session = apply(
      newSession({ kind: "file", name: "w", source: "project" }, TEXT),
      gesture(design, diagram, step("review"), step("build")) ?? { op: "replaceText", text: "" },
    );
    const reviewed = view(session.text, "w");
    expect(reviewed.steps.find((entry) => entry.id === "review")).toMatchObject({
      reviews: "build",
      dependsOn: ["build", "docs"],
    });
  });

  test("up onto a higher step it does not follow makes it a review that then follows it", () => {
    const diagram = layoutDiagram(design.input);
    expect(gesture(design, diagram, step("build"), step("extra"))).toEqual({
      op: "makeReview",
      reviewer: "build",
      target: "extra",
    });
    expect(after(step("build"), step("extra"))).toContain("build<-explore,extra");
  });

  test("anything else changes nothing", () => {
    const { diagram } = carrying("extra");
    const line: Region = { kind: "edge", from: "explore", to: "build" };
    expect(gesture(design, diagram, step("build"), step("build"))).toBeNull();
    expect(gesture(design, diagram, step("build"), null)).toBeNull();
    expect(gesture(design, diagram, null, step("build"))).toBeNull();
    expect(gesture(design, diagram, line, step("review"))).toBeNull();
    expect(gesture(design, diagram, step("extra"), line)).toBeNull();
    expect(gesture(design, diagram, step("review"), { kind: "review", from: "a", to: "b" })).toBe(
      null,
    );
    // A place the picture does not have, as when nothing is being carried.
    expect(gesture(design, diagram, step("extra"), { kind: "slot", index: 999 })).toBeNull();
    expect(
      gesture(design, layoutDiagram(design.input), step("extra"), { kind: "slot", index: 0 }),
    ).toBeNull();
  });
});
