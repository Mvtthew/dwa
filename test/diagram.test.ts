// The picture of a workflow. Each expected picture below was looked at before it was kept:
// every dependency is a line from the bottom of a box (┬) to the top of the next (▼), no line
// goes through a box, and a review runs from the reviewer back to the reviewed step.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DiagramInput,
  type DiagramOptions,
  type DiagramStep,
  diagramText,
  fromDefinition,
  hit,
  layoutDiagram,
  MARKS,
  neighbour,
} from "../src/shared/diagram.ts";
import { checkWorkflow, parseWorkflow, type WorkflowDefinition } from "../src/shared/workflow.ts";
import { looseSteps } from "../src/shared/workflow-edit.ts";

const FEATURE = readFileSync(
  join(import.meta.dir, "..", "examples", "workflows", "feature.toml"),
  "utf8",
);

const step = (id: string, dependsOn: string[] = [], extra: Partial<DiagramStep> = {}) => ({
  id,
  dependsOn,
  ...extra,
});
const picture = (input: DiagramInput, options?: DiagramOptions) =>
  diagramText(layoutDiagram(input, options)).join("\n");

const FEATURE_INPUT = fromDefinition(parseWorkflow(FEATURE, "feature"));
const DIAMOND: DiagramInput = {
  steps: [
    step("start"),
    step("left", ["start"]),
    step("right", ["start"]),
    step("join", ["left", "right"]),
  ],
};
const SKIP: DiagramInput = { steps: [step("a"), step("b", ["a"]), step("c", ["a", "b"])] };
const SIDE_REVIEW: DiagramInput = {
  steps: [
    step("build"),
    step("docs"),
    step("check", ["build"], { reviews: "build", rounds: 2 }),
    step("ship", ["check", "docs"]),
  ],
};

describe("the picture", () => {
  test("the example: three steps in a line and the review back to the build", () => {
    expect(picture(FEATURE_INPUT)).toBe(
      [
        "╭───────────╮",
        "│ explore   │",
        "│ explore   │",
        "╰─────┬─────╯",
        "      │",
        "╭─────▼─────╮",
        "│ build     │◀─×3─╮",
        "│ developer │     │",
        "╰─────┬─────╯     │",
        "      │           │",
        "╭─────▼─────╮     │",
        "│ review    │     │",
        "│ reviewer  ├─────╯",
        "╰───────────╯",
      ].join("\n"),
    );
  });

  test("a diamond: one step, two side by side under it, and a step that joins them", () => {
    expect(picture(DIAMOND)).toBe(
      [
        "        ╭───────────╮",
        "        │ start     │",
        "        │           │",
        "        ╰─────┬─────╯",
        "      ╭───────┴───────╮",
        "╭─────▼─────╮   ╭─────▼─────╮",
        "│ left      │   │ right     │",
        "│           │   │           │",
        "╰─────┬─────╯   ╰─────┬─────╯",
        "      ╰───────╮       │",
        "              ├───────╯",
        "        ╭─────▼─────╮",
        "        │ join      │",
        "        │           │",
        "        ╰───────────╯",
      ].join("\n"),
    );
  });

  test("a dependency that skips a layer goes round the box in between", () => {
    expect(picture(SKIP)).toBe(
      [
        "  ╭───────────╮",
        "  │ a         │",
        "  │           │",
        "  ╰─────┬─────╯",
        "      ╭─┴───────╮",
        "╭─────▼─────╮   │",
        "│ b         │   │",
        "│           │   │",
        "╰─────┬─────╯   │",
        "      ╰─╮       │",
        "        ├───────╯",
        "  ╭─────▼─────╮",
        "  │ c         │",
        "  │           │",
        "  ╰───────────╯",
      ].join("\n"),
    );
    // Two layers skipped: the line passes both boxes on their right.
    expect(
      picture({ steps: [step("a"), step("b", ["a"]), step("c", ["b"]), step("d", ["a", "c"])] }),
    ).toBe(
      [
        "  ╭───────────╮",
        "  │ a         │",
        "  │           │",
        "  ╰─────┬─────╯",
        "      ╭─┴───────╮",
        "╭─────▼─────╮   │",
        "│ b         │   │",
        "│           │   │",
        "╰─────┬─────╯   │",
        "      │         │",
        "╭─────▼─────╮   │",
        "│ c         │   │",
        "│           │   │",
        "╰─────┬─────╯   │",
        "      ╰─╮       │",
        "        ├───────╯",
        "  ╭─────▼─────╮",
        "  │ d         │",
        "  │           │",
        "  ╰───────────╯",
      ].join("\n"),
    );
  });

  test("two steps that depend on nothing stand side by side", () => {
    expect(picture({ steps: [step("one"), step("two"), step("both", ["one", "two"])] })).toBe(
      [
        "╭───────────╮   ╭───────────╮",
        "│ one       │   │ two       │",
        "│           │   │           │",
        "╰─────┬─────╯   ╰─────┬─────╯",
        "      ╰───────╮       │",
        "              ├───────╯",
        "        ╭─────▼─────╮",
        "        │ both      │",
        "        │           │",
        "        ╰───────────╯",
      ].join("\n"),
    );
    // Only one of them is followed: the other has no line.
    expect(picture({ steps: [step("one"), step("two"), step("under-two", ["two"])] })).toBe(
      [
        "╭───────────╮   ╭───────────╮",
        "│ one       │   │ two       │",
        "│           │   │           │",
        "╰───────────╯   ╰─────┬─────╯",
        "              ╭───────╯",
        "        ╭─────▼─────╮",
        "        │ under-two │",
        "        │           │",
        "        ╰───────────╯",
      ].join("\n"),
    );
  });

  test("a review of a step that is not the rightmost of its layer comes in from above", () => {
    // The reviewer is not the rightmost either: its line leaves from under it, crosses the
    // line from docs to ship and goes up outside everything.
    expect(picture(SIDE_REVIEW)).toBe(
      [
        "          ╭────────────────────×2─╮",
        "╭─────────▼─╮   ╭───────────╮     │",
        "│ build     │   │ docs      │     │",
        "│           │   │           │     │",
        "╰─────┬─────╯   ╰─────┬─────╯     │",
        "      ╰─────╮         │           │",
        "      ╭─────▼─────╮   │           │",
        "      │ check     │   │           │",
        "      │           │   │           │",
        "      ╰─────┬───┬─╯   │           │",
        "            │   ╰─────┼───────────╯",
        "            ╰─╮       │",
        "              ├───────╯",
        "        ╭─────▼─────╮",
        "        │ ship      │",
        "        │           │",
        "        ╰───────────╯",
      ].join("\n"),
    );
    expect(
      picture({
        steps: [
          step("start"),
          step("build", ["start"]),
          step("docs", ["start"]),
          step("check", ["build"], { reviews: "build", rounds: 2 }),
          step("lint", ["docs"]),
          step("ship", ["check", "lint"]),
        ],
      }),
    ).toBe(
      [
        "        ╭───────────╮",
        "        │ start     │",
        "        │           │",
        "        ╰─────┬─────╯",
        "      ╭───────┴───────╮",
        "      │   ╭───────────┼────────×2─╮",
        "╭─────▼───▼─╮   ╭─────▼─────╮     │",
        "│ build     │   │ docs      │     │",
        "│           │   │           │     │",
        "╰─────┬─────╯   ╰─────┬─────╯     │",
        "      │               │           │",
        "╭─────▼─────╮   ╭─────▼─────╮     │",
        "│ check     │   │ lint      │     │",
        "│           │   │           │     │",
        "╰─────┬───┬─╯   ╰─────┬─────╯     │",
        "      │   ╰───────────┼───────────╯",
        "      ╰───────╮       │",
        "              ├───────╯",
        "        ╭─────▼─────╮",
        "        │ ship      │",
        "        │           │",
        "        ╰───────────╯",
      ].join("\n"),
    );
  });

  test("two reviews go back up in lanes of their own, the shorter one inside", () => {
    expect(
      picture({
        steps: [
          step("a"),
          step("b", ["a"]),
          step("c", ["b"], { reviews: "b" }),
          step("d", ["c"], { reviews: "a", rounds: 5 }),
        ],
      }),
    ).toBe(
      [
        "╭───────────╮",
        "│ a         │◀──────×5─╮",
        "│           │          │",
        "╰─────┬─────╯          │",
        "      │                │",
        "╭─────▼─────╮          │",
        "│ b         │◀─×3─╮    │",
        "│           │     │    │",
        "╰─────┬─────╯     │    │",
        "      │           │    │",
        "╭─────▼─────╮     │    │",
        "│ c         │     │    │",
        "│           ├─────╯    │",
        "╰─────┬─────╯          │",
        "      │                │",
        "╭─────▼─────╮          │",
        "│ d         │          │",
        "│           ├──────────╯",
        "╰───────────╯",
      ].join("\n"),
    );
  });

  test("the run form: the state before the name, the pass at the right, the agent below", () => {
    const run: DiagramInput = {
      steps: [
        step("explore", [], { lead: "✓", detail: "explore", tone: "good" }),
        step("build", ["explore"], {
          lead: "●",
          mark: "#2",
          detail: "agent build",
          tone: "attention",
        }),
        step("review", ["build"], { lead: "○", detail: "reviewer", reviews: "build", rounds: 3 }),
      ],
    };
    expect(picture(run)).toBe(
      [
        "╭─────────────╮",
        "│ ✓ explore   │",
        "│ explore     │",
        "╰──────┬──────╯",
        "       │",
        "╭──────▼──────╮",
        "│ ● build  #2 │◀─×3─╮",
        "│ agent build │     │",
        "╰──────┬──────╯     │",
        "       │            │",
        "╭──────▼──────╮     │",
        "│ ○ review    │     │",
        "│ reviewer    ├─────╯",
        "╰─────────────╯",
      ].join("\n"),
    );
    // The colour is on the state and the pass, not on the name.
    const cells = layoutDiagram(run).cells[6] ?? [];
    expect(cells.map((cell) => cell.tone ?? "-").join(" ")).toStartWith(
      "- - attention - - - - - - - - attention attention - -",
    );
  });

  test("the selected step has a bar on both lines and its name in inverse video", () => {
    const input: DiagramInput = {
      steps: [step("a", [], { detail: "explore" }), step("b", ["a"], { detail: "developer" })],
    };
    expect(picture(input, { selected: "b" })).toBe(
      [
        "╭───────────╮",
        "│ a         │",
        "│ explore   │",
        "╰─────┬─────╯",
        "      │",
        "╭─────▼─────╮",
        "│▌b         │",
        "│▌developer │",
        "╰───────────╯",
      ].join("\n"),
    );
    const selected = layoutDiagram(input, { selected: "b" });
    const inverse = (row: number) =>
      (selected.cells[row] ?? []).filter((cell) => cell.inverse).length;
    expect(inverse(6)).toBe(10);
    expect(inverse(7)).toBe(0);
    expect(inverse(1)).toBe(0);
    // Nothing selected, or a step that is not there: no bar anywhere.
    expect(picture(input)).not.toContain("▌");
    expect(picture(input, { selected: "zz" })).toBe(picture(input));
    expect(picture(input, { selected: null })).toBe(picture(input));
  });

  test("a long name is cut to the widest box, and the signs stay", () => {
    const input: DiagramInput = {
      steps: [
        step("a-very-long-step-name-that-does-not-fit", [], {
          detail: "role",
          mark: "!",
          note: "∞≡",
        }),
      ],
    };
    expect(picture(input)).toBe(
      [
        "╭────────────────────────╮",
        "│ a-very-long-step-na… ! │",
        "│ role                ∞≡ │",
        "╰────────────────────────╯",
      ].join("\n"),
    );
  });

  test("the size and the boxes say where everything is", () => {
    const diagram = layoutDiagram(FEATURE_INPUT);
    expect([diagram.width, diagram.height]).toEqual([19, 14]);
    expect(diagram.cells).toHaveLength(14);
    expect(diagram.cells.every((row) => row.length === 19)).toBe(true);
    expect(diagram.regions.every((row) => row.length === 19)).toBe(true);
    expect(diagram.boxes).toEqual([
      { id: "explore", x: 0, y: 0, width: 13, height: 4, layer: 0 },
      { id: "build", x: 0, y: 5, width: 13, height: 4, layer: 1 },
      { id: "review", x: 0, y: 10, width: 13, height: 4, layer: 2 },
    ]);
    expect(layoutDiagram({ steps: [] })).toMatchObject({ width: 0, height: 0, boxes: [] });
  });
});

describe("hit", () => {
  const feature = layoutDiagram(FEATURE_INPUT);

  test("a cell inside a box, its border included, gives that step", () => {
    expect(hit(feature, 3, 1)).toEqual({ kind: "step", id: "explore" });
    expect(hit(feature, 0, 0)).toEqual({ kind: "step", id: "explore" });
    expect(hit(feature, 12, 8)).toEqual({ kind: "step", id: "build" });
    // Where a line meets the box it is still the box.
    expect(hit(feature, 6, 3)).toEqual({ kind: "step", id: "explore" });
    expect(hit(feature, 6, 5)).toEqual({ kind: "step", id: "build" });
    expect(hit(feature, 5, 12)).toEqual({ kind: "step", id: "review" });
  });

  test("a cell on a dependency line gives that edge", () => {
    expect(hit(feature, 6, 4)).toEqual({ kind: "edge", from: "explore", to: "build" });
    expect(hit(feature, 6, 9)).toEqual({ kind: "edge", from: "build", to: "review" });
    const diamond = layoutDiagram(DIAMOND);
    expect(hit(diamond, 9, 4)).toEqual({ kind: "edge", from: "start", to: "left" });
    expect(hit(diamond, 19, 4)).toEqual({ kind: "edge", from: "start", to: "right" });
    expect(hit(diamond, 10, 9)).toEqual({ kind: "edge", from: "left", to: "join" });
    expect(hit(diamond, 22, 9)).toEqual({ kind: "edge", from: "right", to: "join" });
    expect(hit(diamond, 18, 10)).toEqual({ kind: "edge", from: "right", to: "join" });
    // A line that passes a layer is the same edge all the way down.
    const skip = layoutDiagram(SKIP);
    for (const [x, y] of [
      [12, 4],
      [16, 6],
      [16, 9],
      [12, 10],
    ] as const) {
      expect(hit(skip, x, y)).toEqual({ kind: "edge", from: "a", to: "c" });
    }
    expect(hit(skip, 7, 9)).toEqual({ kind: "edge", from: "b", to: "c" });
  });

  test("a cell on the review line gives the review, from end to end", () => {
    const review = { kind: "review", from: "review", to: "build" } as const;
    for (const [x, y] of [
      [13, 6],
      [15, 6],
      [16, 6],
      [18, 6],
      [18, 9],
      [18, 12],
      [15, 12],
      [12, 12],
    ] as const) {
      expect(hit(feature, x, y)).toEqual(review);
    }
    const side = layoutDiagram(SIDE_REVIEW);
    const back = { kind: "review", from: "check", to: "build" } as const;
    for (const [x, y] of [
      [10, 0],
      [31, 0],
      [34, 5],
      [16, 9],
      [16, 10],
      [28, 10],
    ] as const) {
      expect(hit(side, x, y)).toEqual(back);
    }
    // Where the review line crosses a dependency, the review is what is pointed at.
    expect(hit(side, 22, 10)).toEqual(back);
    expect(hit(side, 22, 8)).toEqual({ kind: "edge", from: "docs", to: "ship" });
  });

  test("an empty cell, or one outside the picture, gives null", () => {
    expect(hit(feature, 15, 1)).toBeNull();
    expect(hit(feature, 3, 4)).toBeNull();
    expect(hit(feature, 15, 8)).toBeNull();
    expect(hit(feature, 18, 13)).toBeNull();
    expect(hit(feature, -1, 0)).toBeNull();
    expect(hit(feature, 0, -1)).toBeNull();
    expect(hit(feature, 19, 0)).toBeNull();
    expect(hit(feature, 0, 14)).toBeNull();
  });

  test("every cell with a region has something drawn, and every line or box cell has a region", () => {
    for (const input of [FEATURE_INPUT, DIAMOND, SKIP, SIDE_REVIEW]) {
      const diagram = layoutDiagram(input);
      for (let y = 0; y < diagram.height; y++) {
        for (let x = 0; x < diagram.width; x++) {
          const region = hit(diagram, x, y);
          const inBox = diagram.boxes.some(
            (box) => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height,
          );
          const char = diagram.cells[y]?.[x]?.char;
          if (inBox) expect(region?.kind).toMatch(/step|review/);
          else expect(region === null).toBe(char === " ");
        }
      }
    }
  });
});

describe("neighbour", () => {
  const go = (input: DiagramInput, id: string) => {
    const diagram = layoutDiagram(input);
    return (["up", "down", "left", "right"] as const).map((direction) =>
      neighbour(diagram, input, id, direction),
    );
  };

  test("goes up and down along the dependencies and left and right along the layer", () => {
    expect(go(DIAMOND, "start")).toEqual([null, "left", null, null]);
    expect(go(DIAMOND, "left")).toEqual(["start", "join", null, "right"]);
    expect(go(DIAMOND, "right")).toEqual(["start", "join", "left", null]);
    expect(go(DIAMOND, "join")).toEqual(["left", null, null, null]);
    expect(go(FEATURE_INPUT, "build")).toEqual(["explore", "review", null, null]);
  });

  test("prefers a step it is joined to, then the nearest layer, then the nearest box", () => {
    // c depends on a and on b: b is the nearer of the two.
    expect(go(SKIP, "c")[0]).toBe("b");
    expect(go(SKIP, "a")[1]).toBe("b");
    // docs is joined to ship two layers down, not to check right below it.
    expect(go(SIDE_REVIEW, "docs")).toEqual([null, "ship", "build", null]);
    expect(go(SIDE_REVIEW, "ship")[0]).toBe("check");
    expect(go(SIDE_REVIEW, "check")).toEqual(["build", "ship", null, null]);
    // Joined to nothing below: the nearest box of the next layer.
    const loose: DiagramInput = {
      steps: [step("one"), step("two"), step("three"), step("under", ["one"])],
    };
    expect(go(loose, "three")).toEqual([null, "under", "two", null]);
    expect(go(loose, "under")).toEqual(["one", null, null, null]);
  });

  test("a step that is not in the picture leads to the first one", () => {
    const diagram = layoutDiagram(DIAMOND);
    expect(neighbour(diagram, DIAMOND, "zz", "down")).toBe("start");
    expect(neighbour(layoutDiagram({ steps: [] }), { steps: [] }, "zz", "up")).toBeNull();
  });
});

describe("fromDefinition", () => {
  test("puts the role on the second line and the review with its passes", () => {
    expect(FEATURE_INPUT).toEqual({
      steps: [
        { id: "explore", dependsOn: [], detail: "explore" },
        { id: "build", dependsOn: ["explore"], detail: "developer" },
        { id: "review", dependsOn: ["build"], reviews: "build", rounds: 3, detail: "reviewer" },
      ],
    });
  });

  test("marks a step with problems, one that keeps its agent and one with settings of its own", () => {
    expect(MARKS).toEqual({ problem: "!", keepsAgent: "∞", ownSettings: "≡" });
    const definition = parseWorkflow(
      '[steps.plain]\nprompt = "p"\n\n' +
        '[steps.kept]\nprompt = "k"\nkeep_agent = true\n\n' +
        '[steps.own]\nrole = "developer"\nprompt = "o"\nmodel = "opus"\n\n' +
        '[steps.both]\nprompt = "b"\nkeep_agent = true\ndeny_tools = ["Edit"]\ndepends_on = ["own"]\n',
      "w",
    );
    const problems = [
      { message: "something about it", step: "own", key: "prompt" },
      { message: "about the whole file" },
    ];
    const input = fromDefinition(definition, problems);
    expect(
      input.steps.map(({ id, mark, note, tone, detail }) => [id, mark, note, tone, detail]),
    ).toEqual([
      ["plain", undefined, undefined, undefined, "no role"],
      ["kept", undefined, "∞", undefined, "no role"],
      ["own", "!", "≡", "bad", "developer"],
      ["both", undefined, "∞≡", undefined, "no role"],
    ]);
    expect(picture(input)).toBe(
      [
        "╭─────────────╮   ╭─────────────╮   ╭─────────────╮",
        "│ plain       │   │ kept        │   │ own       ! │",
        "│ no role     │   │ no role   ∞ │   │ developer ≡ │",
        "╰─────────────╯   ╰─────────────╯   ╰──────┬──────╯",
        "                         ╭─────────────────╯",
        "                  ╭──────▼──────╮",
        "                  │ both        │",
        "                  │ no role  ∞≡ │",
        "                  ╰─────────────╯",
      ].join("\n"),
    );
    // A role or a review is not a setting of its own.
    expect(fromDefinition(parseWorkflow(FEATURE, "feature")).steps.map((s) => s.note)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  /** A text that is TOML but not a valid workflow, as the picture's input, with its problems. */
  function loose(text: string): DiagramInput {
    const steps = Object.fromEntries(
      Object.entries(looseSteps(text)).map(([id, found]) => [
        id,
        { ...found.fields, depends_on: found.depends_on, keep_agent: false },
      ]),
    ) as WorkflowDefinition["steps"];
    const check = checkWorkflow(text, "w");
    expect(check.definition).toBeNull();
    return fromDefinition({ name: "w", steps }, check.problems);
  }

  test("a text with an unknown dependency still lays out, the step marked", () => {
    const input = loose(
      '[steps.a]\nprompt = "a"\ndepends_on = ["nope"]\n\n' +
        '[steps.b]\nprompt = "b"\ndepends_on = ["a"]\nreviews = "gone"\n',
    );
    // a depends on a step that is not there, b reviews one that is not there.
    expect(input.steps.map((s) => [s.mark, s.tone])).toEqual([
      ["!", "bad"],
      ["!", "bad"],
    ]);
    expect(picture(input)).toBe(
      [
        "╭───────────╮",
        "│ a       ! │",
        "│ no role   │",
        "╰─────┬─────╯",
        "      │",
        "╭─────▼─────╮",
        "│ b       ! │",
        "│ no role   │",
        "╰───────────╯",
      ].join("\n"),
    );
  });

  test("a text with a dependency loop still lays out, with every step in it", () => {
    const texts = [
      '[steps.a]\nprompt = "a"\ndepends_on = ["b"]\n\n[steps.b]\nprompt = "b"\ndepends_on = ["a"]\n',
      '[steps.a]\nprompt = "a"\ndepends_on = ["a"]\n',
      '[steps.a]\nprompt = "a"\n\n[steps.b]\nprompt = "b"\ndepends_on = ["a", "d"]\n\n' +
        '[steps.c]\nprompt = "c"\ndepends_on = ["b"]\nreviews = "d"\n\n' +
        '[steps.d]\nprompt = "d"\ndepends_on = ["c"]\nreviews = "d"\n',
    ];
    for (const text of texts) {
      const input = loose(text);
      expect(() => layoutDiagram(input, { selected: input.steps[0]?.id })).not.toThrow();
      const diagram = layoutDiagram(input);
      const ids = input.steps.map((s) => s.id);
      expect(diagram.boxes.map((box) => box.id).sort()).toEqual([...ids].sort());
      const drawn = diagramText(diagram).join("\n");
      for (const id of ids) expect(drawn).toContain(` ${id} `);
      expect(diagram.cells.every((row) => row.length === diagram.width)).toBe(true);
      for (const id of ids) {
        for (const direction of ["up", "down", "left", "right"] as const) {
          expect(() => neighbour(diagram, input, id, direction)).not.toThrow();
        }
      }
    }
  });

  // Today the step the loop is found at counts as layer 0 without being placed there, so the
  // two boxes of a -> b -> a start on row 5 under five empty rows.
  test("a loop leaves no empty layer at the top of the picture", () => {
    const input: DiagramInput = { steps: [step("a", ["b"]), step("b", ["a"])] };
    const diagram = layoutDiagram(input);
    expect(Math.min(...diagram.boxes.map((box) => box.y))).toBe(0);
    expect(diagramText(diagram)[0]).not.toBe("");
  });
});
