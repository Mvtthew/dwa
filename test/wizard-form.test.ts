// The form on its own (as the designer's panel uses it), the field for text of several lines,
// and a wizard that hands the popup to a view and gets it back.
import { afterEach, describe, expect, test } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { Tone } from "../src/ui/model.ts";
import {
  createForm,
  createWizard,
  type Form,
  OFF,
  ON,
  type Outcome,
  type Row,
  type Screen,
  type Values,
  type View,
  type ViewHost,
} from "../src/ui/wizard.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});

async function harnessOf(width = 60, height = 30) {
  const harness = await createTestRenderer({ width, height });
  cleanup.push(() => harness.renderer.destroy());
  const frame = async () => {
    await Bun.sleep(5);
    await harness.renderOnce();
    return harness.captureCharFrame();
  };
  /** Clicks the lowest place `text` is shown. */
  const click = async (text: string) => {
    const lines = (await frame()).split("\n");
    const y = lines.findLastIndex((line) => line.includes(text));
    if (y === -1) throw new Error(`"${text}" is not on screen:\n${lines.join("\n")}`);
    await harness.mockMouse.click((lines[y] ?? "").indexOf(text) + 1, y);
    await frame();
  };
  return { harness, frame, click };
}

/** A form on a screen of its own, with the keys sent to it and what it reports collected. */
async function formOn(screen: Screen, options: { id?: string; width?: number } = {}) {
  const { harness, frame, click } = await harnessOf();
  const status: { message: { text: string; tone: Tone } | null; hints: string }[] = [];
  const outcomes: Outcome[] = [];
  const changes: Values[] = [];
  const unhandled: string[] = [];
  const form: Form = createForm(harness.renderer, {
    id: options.id ?? "panel",
    width: () => options.width ?? 40,
    status: (message, hints) => status.push({ message, hints }),
    outcome: (outcome) => outcomes.push(outcome),
    changed: (values) => changes.push(values),
  });
  const root = new BoxRenderable(harness.renderer, {
    id: "test-root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });
  root.add(form.list);
  harness.renderer.root.add(root);
  harness.renderer.keyInput.on("keypress", (key) => {
    if (!form.key(key)) unhandled.push(key.name);
  });
  form.show(screen);
  return { harness, frame, click, form, root, status, outcomes, changes, unhandled };
}

const sample = (run: (values: Values) => Outcome | Promise<Outcome> = () => ({ close: true })) =>
  ({
    title: "Sample",
    values: { name: "first", keep: ON },
    rows: [
      { kind: "heading", text: "DETAILS" },
      { kind: "note", text: "", live: (values) => `Hello ${values.name}` },
      { kind: "input", key: "name", label: "Name" },
      { kind: "check", key: "keep", label: "Keeps its agent", hint: "stays open" },
      {
        kind: "choice",
        key: "model",
        label: "Model",
        options: [
          { value: "", label: "default" },
          { value: "opus", label: "opus" },
        ],
      },
      { kind: "button", label: "Go", hint: "does it", run },
    ],
  }) satisfies Screen;

describe("a form on its own", () => {
  test("draws a screen's rows, starts with the keyboard on the first field and says the keys", async () => {
    const { frame, form, status } = await formOn(sample());
    const shown = await frame();
    expect(shown).toContain("DETAILS");
    expect(shown).toContain("Hello first");
    expect(shown).toContain("▌  Name");
    expect(shown).toMatch(/│ first\s+│/);
    expect(shown).toContain("[x] Keeps its agent");
    expect(shown).toContain("stays open");
    expect(shown).toContain("[default] opus");
    expect(shown).toContain("Go  does it");
    // It has no title or footer of its own: those are the caller's.
    expect(shown).not.toContain("Sample");
    expect(form.values()).toEqual({ name: "first", keep: ON, model: "" });
    expect(status.at(-1)).toEqual({
      message: null,
      hints: "click, or ↑↓ and enter · ←→ changes a choice · esc goes back",
    });
    expect(form.busy()).toBe(false);
  });

  test("reports what is typed, switched and chosen, and notes follow", async () => {
    const { harness, frame, click, form, changes, status } = await formOn(sample());
    await harness.mockInput.typeText("!");
    expect(changes.at(-1)).toEqual({ name: "first!", keep: ON, model: "" });
    expect(await frame()).toContain("Hello first!");

    harness.mockInput.pressArrow("down");
    await frame();
    expect(status.at(-1)?.hints).toBe("click, or ↑↓ · space switches · esc goes back");
    harness.mockInput.pressKey(" ");
    expect(await frame()).toContain("[ ] Keeps its agent");
    expect(changes.at(-1)?.keep).toBe(OFF);

    harness.mockInput.pressArrow("down");
    harness.mockInput.pressArrow("right");
    expect(await frame()).toContain(" default [opus]");
    expect(changes.at(-1)?.model).toBe("opus");

    await click("Keeps its agent");
    expect(form.values()).toEqual({ name: "first!", keep: ON, model: "opus" });
    await click("default");
    expect(form.values().model).toBe("");
    // What it hands out is a copy.
    form.values().name = "changed";
    expect(form.values().name).toBe("first!");
  });

  test("hands a button's outcome to the caller with the values, by click and by enter", async () => {
    const seen: Values[] = [];
    const { harness, frame, click, outcomes } = await formOn(
      sample((values) => {
        seen.push(values);
        return { exec: ["workflow", "run"] };
      }),
    );
    await click("Go");
    expect(outcomes).toEqual([{ exec: ["workflow", "run"] }]);
    harness.mockInput.pressEnter();
    await frame();
    expect(outcomes).toHaveLength(2);
    expect(seen).toEqual([
      { name: "first", keep: ON, model: "" },
      { name: "first", keep: ON, model: "" },
    ]);
  });

  test("a button that refuses shows why and hands nothing on", async () => {
    const { click, outcomes, status } = await formOn(
      sample(() => {
        throw new Error("Not like this.");
      }),
    );
    await click("Go");
    expect(outcomes).toEqual([]);
    expect(status.at(-1)?.message).toEqual({ text: "Not like this.", tone: "bad" });
  });

  test("is busy while a button works and takes no second press meanwhile", async () => {
    let finish: (outcome: Outcome) => void = () => undefined;
    let presses = 0;
    const { harness, frame, click, form, outcomes, status } = await formOn(
      sample(() => {
        presses += 1;
        return new Promise<Outcome>((resolve) => {
          finish = resolve;
        });
      }),
    );
    await click("Go");
    expect(form.busy()).toBe(true);
    expect(status.at(-1)?.message).toEqual({ text: "…", tone: "muted" });
    await click("Go");
    harness.mockInput.pressEnter();
    harness.mockInput.pressArrow("up");
    await frame();
    expect(presses).toBe(1);
    finish({ back: true });
    await frame();
    expect(form.busy()).toBe(false);
    expect(outcomes).toEqual([{ back: true }]);
  });

  test("a redraw keeps what the form holds and where the keyboard is; a new screen starts afresh", async () => {
    const { harness, frame, form } = await formOn(sample());
    await harness.mockInput.typeText("!");
    harness.mockInput.pressArrow("down");
    harness.mockInput.pressArrow("down");
    await frame();
    const again: Screen = { ...sample(), values: { keep: OFF } };
    form.show(again, true);
    // Only what the new screen names is changed.
    expect(form.values()).toEqual({ name: "first!", keep: OFF, model: "" });
    expect(await frame()).toContain("▌  Model");
    expect(await frame()).toMatch(/│ first!\s+│/);

    form.show(sample());
    expect(form.values()).toEqual({ name: "first", keep: ON, model: "" });
    expect(await frame()).toContain("▌  Name");
  });

  test("on a redraw with fewer rows the keyboard goes to the nearest row before", async () => {
    const { harness, frame, form } = await formOn(sample());
    for (let i = 0; i < 3; i++) harness.mockInput.pressArrow("down");
    expect(await frame()).toContain("▌  Go ");
    form.show({ title: "Sample", rows: sample().rows.slice(0, 4) }, true);
    expect(await frame()).toMatch(/▌ +\[x\] Keeps its agent/);
  });

  test("without the keyboard no row is marked and no field takes typing", async () => {
    const { harness, frame, form } = await formOn(sample());
    form.setActive(false);
    expect(await frame()).not.toContain("▌");
    await harness.mockInput.typeText("zzz");
    expect(form.values().name).toBe("first");
    form.setActive(true);
    expect(await frame()).toContain("▌  Name");
    await harness.mockInput.typeText("!");
    expect(form.values().name).toBe("first!");
  });

  test("a message from the caller is shown until the next action", async () => {
    const { harness, frame, form, status } = await formOn(sample());
    form.say("Saved as a draft.", "good");
    expect(status.at(-1)?.message).toEqual({ text: "Saved as a draft.", tone: "good" });
    // Moving over the rows is not one.
    for (let i = 0; i < 3; i++) harness.mockInput.pressArrow("down");
    await frame();
    expect(status.at(-1)?.message).toEqual({ text: "Saved as a draft.", tone: "good" });
    harness.mockInput.pressEnter();
    await frame();
    form.show(sample(), true);
    expect(status.at(-1)?.message).toBeNull();
  });

  test("says which keys are its own, so the caller can use the others", async () => {
    const { harness, frame, unhandled } = await formOn(sample());
    harness.mockInput.pressArrow("down");
    harness.mockInput.pressTab();
    harness.mockInput.pressTab({ shift: true });
    await frame();
    expect(unhandled).toEqual([]);
    // On the switch: a letter and an arrow that means nothing there are the caller's.
    harness.mockInput.pressKey("q");
    harness.mockInput.pressArrow("left");
    await frame();
    expect(unhandled).toEqual(["q", "left"]);
  });

  test("a switch that is fixed says why and is not changed; one with more opens it", async () => {
    const asked: Values[] = [];
    const { harness, frame, click, form, outcomes, changes, status } = await formOn({
      title: "Tools",
      values: { dwa: ON },
      rows: [
        { kind: "check", key: "dwa", label: "dwa", fixed: "always on" },
        {
          kind: "check",
          key: "github",
          label: "github",
          hint: "2 tools ›",
          more: (values) => {
            asked.push(values);
            return { to: { title: "github", rows: [] } };
          },
        },
      ],
    });
    expect(await frame()).toContain("always on");
    harness.mockInput.pressKey(" ");
    await click("dwa");
    expect(form.values().dwa).toBe(ON);
    expect(changes).toEqual([]);

    harness.mockInput.pressArrow("down");
    await frame();
    expect(status.at(-1)?.hints).toContain("→ shows more");
    harness.mockInput.pressArrow("right");
    await frame();
    await click("2 tools");
    expect(outcomes).toHaveLength(2);
    expect(asked[0]).toEqual({ dwa: ON, github: OFF });
    // A click on the label still switches it.
    await click("github");
    expect(form.values().github).toBe(ON);
  });

  test("two forms with ids of their own share a screen", async () => {
    const { harness, frame, root, form } = await formOn(sample(), { id: "left" });
    const other = createForm(harness.renderer, {
      id: "right",
      width: () => 40,
      status: () => undefined,
      outcome: () => undefined,
    });
    root.add(other.list);
    // Only one of the two has the keyboard.
    other.setActive(false);
    other.show({ title: "Other", rows: [{ kind: "input", key: "name", label: "Second name" }] });
    const shown = await frame();
    expect(shown).toContain("▌  Name");
    expect(shown).toContain("Second name");
    await harness.mockInput.typeText("!");
    expect(form.values().name).toBe("first!");
    expect(other.values()).toEqual({ name: "" });
    other.destroy();
    expect(await frame()).not.toContain("Second name");
  });
});

describe("a field for text of several lines", () => {
  const prompt = (inserts?: { label: string; text: string }[]): Screen => ({
    title: "Step",
    values: { prompt: "Build it" },
    rows: [
      { kind: "text", key: "prompt", label: "Prompt", height: 4, ...(inserts ? { inserts } : {}) },
      { kind: "button", label: "Done", run: () => ({ close: true }) },
    ],
  });
  const pieces = [
    { label: "input", text: "{{input}}" },
    { label: "explore", text: "{{steps.explore.result}}" },
  ];

  test("shows its text in a frame of the height asked for, with the pieces under it", async () => {
    const { frame, status } = await formOn(prompt(pieces));
    const lines = (await frame()).split("\n");
    const label = lines.findIndex((line) => line.includes("▌  Prompt"));
    expect(label).toBeGreaterThanOrEqual(0);
    expect(lines[label + 1]).toMatch(/^ {3}╭─+╮/);
    expect(lines[label + 2]).toMatch(/^ {3}│ Build it\s+│/);
    expect(lines[label + 6]).toMatch(/^ {3}╰─+╯/);
    expect(lines[label + 7]).toContain(" 1 input  2 explore ");
    expect(lines[label + 8]).toContain("Done");
    expect(status.at(-1)?.hints).toBe(
      "type here · tab moves on · alt and a number puts a piece in · esc goes back",
    );
  });

  test("without pieces there is no line for them and the keys say so", async () => {
    const { frame, status } = await formOn(prompt());
    const lines = (await frame()).split("\n");
    const label = lines.findIndex((line) => line.includes("▌  Prompt"));
    expect(lines[label + 6]).toMatch(/^ {3}╰─+╯/);
    expect(lines[label + 7]).toContain("Done");
    expect(status.at(-1)?.hints).toBe("type here · tab moves on · esc goes back");
  });

  test("takes typing with enter as a new line, and reports every change", async () => {
    const { harness, frame, form, changes, outcomes } = await formOn({
      ...prompt(),
      values: {},
    });
    expect(form.values()).toEqual({ prompt: "" });
    await harness.mockInput.typeText("one");
    harness.mockInput.pressEnter();
    await harness.mockInput.typeText("two");
    await frame();
    expect(form.values().prompt).toBe("one\ntwo");
    expect(changes.at(-1)).toEqual({ prompt: "one\ntwo" });
    expect(changes.length).toBeGreaterThan(1);
    // Enter did not press anything.
    expect(outcomes).toEqual([]);
    const lines = (await frame()).split("\n");
    const first = lines.findIndex((line) => /│ one\s+│/.test(line));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(lines[first + 1]).toMatch(/│ two\s+│/);
  });

  test("arrows and letters are typing there; tab moves on and shift-tab back", async () => {
    const { harness, frame, form, unhandled, outcomes } = await formOn(prompt());
    harness.mockInput.pressArrow("down");
    harness.mockInput.pressArrow("up");
    harness.mockInput.pressKey("q");
    expect(await frame()).toContain("▌  Prompt");
    // The form leaves them to the field, which the caller can tell.
    expect(unhandled).toEqual(["down", "up", "q"]);
    expect(form.values().prompt).toContain("q");

    const typed = form.values().prompt;
    harness.mockInput.pressTab();
    expect(await frame()).toContain("▌  Done ");
    // The tab it was left with is not typed into it.
    expect(form.values().prompt).toBe(typed);
    harness.mockInput.pressEnter();
    await frame();
    expect(outcomes).toEqual([{ close: true }]);
    harness.mockInput.pressTab({ shift: true });
    expect(await frame()).toContain("▌  Prompt");
  });

  test("a click on a piece, or alt and its number, puts it in at the cursor", async () => {
    const { harness, frame, click, form, changes } = await formOn({
      ...prompt(pieces),
      values: { prompt: "" },
    });
    await harness.mockInput.typeText("Use ");
    await click("2 explore");
    expect(form.values().prompt).toBe("Use {{steps.explore.result}}");
    // The field has the keyboard again after the click.
    await harness.mockInput.typeText(" and ");
    harness.mockInput.pressKey("1", { meta: true });
    await frame();
    expect(form.values().prompt).toBe("Use {{steps.explore.result}} and {{input}}");
    expect(changes.at(-1)).toEqual({ prompt: "Use {{steps.explore.result}} and {{input}}" });
    // A number without a piece is not one of the form's keys.
    harness.mockInput.pressKey("9", { meta: true });
    await frame();
    expect(form.values().prompt).not.toContain("9}}");
    expect(form.values().prompt).toStartWith("Use {{steps.explore.result}} and {{input}}");
  });

  test("a click on the field gives it the keyboard", async () => {
    const { harness, frame, click, form } = await formOn(prompt());
    harness.mockInput.pressTab();
    expect(await frame()).toContain("▌  Done ");
    await click("Build it");
    expect(await frame()).toContain("▌  Prompt");
    await harness.mockInput.typeText("!");
    expect(form.values().prompt).toContain("!");
  });

  test("a redraw keeps the text typed so far", async () => {
    const { harness, frame, form } = await formOn(prompt(pieces));
    await harness.mockInput.typeText("X");
    await frame();
    const typed = form.values().prompt;
    expect(typed).toContain("X");
    form.show({ ...prompt(pieces), values: {} }, true);
    expect(form.values().prompt).toBe(typed);
    expect(await frame()).toContain("▌  Prompt");
  });
});

describe("a wizard that hands the popup to a view", () => {
  const HOME: Screen = {
    title: "Changed list",
    rows: [{ kind: "button", label: "Fresh", run: () => ({ close: true }) }],
  };

  /** A view that shows a line and resolves when the test says so. */
  function fakeView(name: string) {
    const hosts: ViewHost[] = [];
    let resolve: (outcome: Outcome) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    let box: BoxRenderable | null = null;
    const view: View = (host) => {
      hosts.push(host);
      box = new BoxRenderable(host.renderer, {
        id: `view-${name}-${hosts.length}`,
        width: 30,
        height: 3,
        border: true,
        title: `VIEW ${name}`,
      });
      host.parent.add(box);
      const gone = () => {
        if (box) host.parent.remove(box);
        box?.destroyRecursively();
        box = null;
      };
      return new Promise<Outcome>((done, fail) => {
        resolve = (outcome) => {
          gone();
          done(outcome);
        };
        reject = (error) => {
          gone();
          fail(error);
        };
      });
    };
    return {
      view,
      hosts,
      end: (outcome: Outcome) => resolve(outcome),
      fail: (error: Error) => reject(error),
    };
  }

  const list = (rows: Row[]): Screen => ({ title: "The list", rows });
  const open = (view: View, label = "Open"): Row => ({
    kind: "button",
    label,
    run: () => ({ view }),
  });

  async function setup(first: Screen, then?: Outcome) {
    const { harness, frame, click } = await harnessOf();
    let result: string[] | null | undefined;
    const done = createWizard(harness.renderer, first, then);
    void done.then((value) => {
      result = value;
    });
    const pressEsc = async () => {
      harness.mockInput.pressEscape();
      // A lone escape is only told apart from the start of a key sequence after a moment.
      await Bun.sleep(100);
      return frame();
    };
    return { harness, frame, click, done, pressEsc, ended: () => result !== undefined };
  }

  test("the view gets the popup and the keys; the screens are hidden until it is done", async () => {
    const designer = fakeView("designer");
    const { harness, frame, click, pressEsc, ended } = await setup(list([open(designer.view)]));
    await click("Open");
    expect(designer.hosts).toHaveLength(1);
    expect(designer.hosts[0]?.renderer).toBe(harness.renderer);
    const shown = await frame();
    expect(shown).toContain("VIEW designer");
    expect(shown).not.toContain("The list");
    expect(shown).not.toContain("Open");
    // Escape and enter are the view's now, not the wizard's.
    await pressEsc();
    harness.mockInput.pressEnter();
    await frame();
    expect(ended()).toBe(false);
    expect(designer.hosts).toHaveLength(1);

    designer.end({ replace: list([{ kind: "note", text: "Back from the view." }]) });
    const after = await frame();
    expect(after).toContain("The list");
    expect(after).toContain("Back from the view.");
    expect(after).not.toContain("VIEW designer");
  });

  test("a view that closes ends the wizard, and one that asks for a command hands it back", async () => {
    const closing = fakeView("a");
    const first = await setup(list([open(closing.view)]));
    await first.click("Open");
    closing.end({ close: true });
    expect(await first.done).toBeNull();

    const running = fakeView("b");
    const second = await setup(list([open(running.view)]));
    await second.click("Open");
    running.end({ exec: ["workflow", "edit", "2"] });
    expect(await second.done).toEqual(["workflow", "edit", "2"]);
  });

  test("a view that fails gives the popup back with the reason", async () => {
    const broken = fakeView("broken");
    const { frame, click, ended } = await setup(list([open(broken.view)]));
    await click("Open");
    broken.fail(new Error("The daemon is not running."));
    const shown = await frame();
    expect(shown).toContain("The list");
    expect(shown).toContain("The daemon is not running.");
    expect(ended()).toBe(false);
    // And it can be opened again.
    await click("Open");
    expect(broken.hosts).toHaveLength(2);
  });

  test("a screen a view goes to belongs to it: back and escape show the view again", async () => {
    const designer = fakeView("designer");
    const save: Screen = {
      title: "Save it?",
      rows: [{ kind: "button", label: "Back", run: () => ({ back: true }) }],
    };
    const { frame, click, pressEsc, ended } = await setup(list([open(designer.view)]));
    await click("Open");
    designer.end({ to: save });
    expect(await frame()).toContain("Save it?");
    expect(await frame()).not.toContain("VIEW designer");

    await click("Back");
    expect(designer.hosts).toHaveLength(2);
    expect(await frame()).toContain("VIEW designer");
    expect(await frame()).not.toContain("Save it?");

    designer.end({ to: save });
    await frame();
    expect(await pressEsc()).toContain("VIEW designer");
    expect(designer.hosts).toHaveLength(3);
    expect(ended()).toBe(false);
  });

  test("screens opened from a view's screen are the view's too, and are left one at a time", async () => {
    const designer = fakeView("designer");
    const deeper: Screen = {
      title: "Deeper",
      rows: [{ kind: "button", label: "Back", run: () => ({ back: true }) }],
    };
    const panel: Screen = {
      title: "Pick a role",
      rows: [{ kind: "button", label: "More", run: () => ({ to: deeper }) }],
    };
    const { frame, click, pressEsc } = await setup(list([open(designer.view)]));
    await click("Open");
    designer.end({ to: panel });
    await click("More");
    expect(await frame()).toContain("Deeper");
    // Going back from a screen of the view's shows the view; the screen under it is kept
    // and comes next.
    await click("Back");
    expect(designer.hosts).toHaveLength(2);
    designer.end({ back: true });
    await frame();
    expect(designer.hosts).toHaveLength(3);
    expect(await frame()).toContain("VIEW designer");
    designer.end({ replace: list([{ kind: "note", text: "Home again." }]) });
    expect(await frame()).toContain("Home again.");
    expect(await pressEsc()).toContain("Home again.");
  });

  test("home ends a view for good: its screens go and the list is shown anew", async () => {
    const designer = fakeView("designer");
    const leave: Screen = {
      title: "Unsaved changes",
      rows: [{ kind: "button", label: "Leave", run: () => ({ home: HOME }) }],
    };
    const { frame, click, pressEsc, done } = await setup(list([open(designer.view)]));
    await click("Open");
    designer.end({ to: leave });
    await click("Leave");
    const shown = await frame();
    expect(shown).toContain("Changed list");
    expect(shown).toContain("Fresh");
    expect(shown).not.toContain("Unsaved changes");
    expect(shown).not.toContain("VIEW designer");
    expect(designer.hosts).toHaveLength(1);
    // The new list stands where the old one stood: escape closes the wizard, not the view.
    await pressEsc();
    expect(await done).toBeNull();
    expect(designer.hosts).toHaveLength(1);
  });

  test("a view can resolve with home itself, and the list under it is kept", async () => {
    const designer = fakeView("designer");
    const menu: Screen = {
      title: "Menu",
      rows: [
        { kind: "button", label: "Workflows", run: () => ({ to: list([open(designer.view)]) }) },
      ],
    };
    const { frame, click, pressEsc, ended } = await setup(menu);
    await click("Workflows");
    await click("Open");
    designer.end({ home: HOME });
    expect(await frame()).toContain("Changed list");
    // What was under the list is still there.
    expect(await pressEsc()).toContain("Menu");
    expect(ended()).toBe(false);
  });

  test("a view started from a view's screen takes that screen's place", async () => {
    const first = fakeView("first");
    const second = fakeView("second");
    const offer: Screen = {
      title: "Unsaved work",
      rows: [{ kind: "button", label: "Continue", run: () => ({ view: second.view }) }],
    };
    const leave: Screen = {
      title: "Leaving",
      rows: [{ kind: "button", label: "Back", run: () => ({ back: true }) }],
    };
    const { frame, click } = await setup(list([open(first.view)]));
    await click("Open");
    first.end({ to: offer });
    await click("Continue");
    expect(await frame()).toContain("VIEW second");
    second.end({ to: leave });
    await click("Back");
    // Back to the second view, not to the screen that offered it nor to the first view.
    expect(second.hosts).toHaveLength(2);
    expect(first.hosts).toHaveLength(1);
    second.end({ home: HOME });
    const shown = await frame();
    expect(shown).toContain("Changed list");
    expect(shown).not.toContain("Unsaved work");
  });

  test("a wizard can start with a view straight away, over its first screen", async () => {
    const designer = fakeView("designer");
    const { frame, pressEsc, done } = await setup(list([open(designer.view)]), {
      view: designer.view,
    });
    expect(designer.hosts).toHaveLength(1);
    expect(await frame()).toContain("VIEW designer");
    expect(await frame()).not.toContain("The list");
    designer.end({ home: HOME });
    expect(await frame()).toContain("Changed list");
    await pressEsc();
    expect(await done).toBeNull();
  });

  test("a wizard can start on a second screen, with the first to go back to", async () => {
    const { frame, pressEsc, ended } = await setup(list([{ kind: "note", text: "Underneath." }]), {
      to: { title: "Opened at once", rows: [] },
    });
    expect(await frame()).toContain("Opened at once");
    expect(await pressEsc()).toContain("Underneath.");
    expect(ended()).toBe(false);
  });
});
