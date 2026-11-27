import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createWizard, OFF, ON, type Screen, type Values } from "../src/ui/wizard.ts";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

async function setup(first: Screen) {
  const harness = await createTestRenderer({ width: 60, height: 24 });
  dispose = () => harness.renderer.destroy();
  const done = createWizard(harness.renderer, first);
  const frame = async () => {
    await harness.renderOnce();
    return harness.captureCharFrame();
  };
  const click = async (text: string) => {
    const lines = (await frame()).split("\n");
    const y = lines.findLastIndex((line) => line.includes(text));
    if (y === -1) throw new Error(`"${text}" is not on screen:\n${lines.join("\n")}`);
    await harness.mockMouse.click((lines[y] ?? "").indexOf(text) + 1, y);
    await Bun.sleep(5);
    await harness.renderOnce();
  };
  return { harness, done, frame, click };
}

/** A list of switches whose "github" row can show its tools, and a note counting what is off. */
function screen(sent: Values[], expanded = false): Screen {
  return {
    title: "Tools",
    values: { Read: ON, Edit: OFF, dwa: ON, github: ON, "github/create": ON },
    rows: [
      { kind: "heading", text: "BUILT-IN TOOLS" },
      { kind: "check", key: "Read", label: "Read" },
      { kind: "check", key: "Edit", label: "Edit", hint: "blocked" },
      { kind: "check", key: "dwa", label: "dwa", fixed: "always on" },
      {
        kind: "check",
        key: "github",
        label: "github",
        hint: "2 tools ›",
        more: () => ({ replace: { ...screen(sent, true), values: {} } }),
      },
      ...(expanded
        ? [{ kind: "check" as const, key: "github/create", label: "  create_issue" }]
        : []),
      {
        kind: "note",
        text: "",
        live: (values) => `${Object.values(values).filter((value) => value === OFF).length} off`,
      },
      {
        kind: "button",
        label: "Save",
        run: (values) => {
          sent.push(values);
          return { close: true };
        },
      },
    ],
  };
}

describe("switch rows", () => {
  test("space, enter and clicks change a switch, and a fixed one stays", async () => {
    const sent: Values[] = [];
    const { harness, done, frame, click } = await setup(screen(sent));
    expect(await frame()).toContain("[x] Read");
    expect(await frame()).toContain("[ ] Edit");
    expect(await frame()).toContain("1 off");

    harness.mockInput.pressKey(" ");
    expect(await frame()).toContain("[ ] Read");
    expect(await frame()).toContain("2 off");
    harness.mockInput.pressArrow("down");
    harness.mockInput.pressEnter();
    expect(await frame()).toContain("[x] Edit");

    await click("[x] dwa");
    expect(await frame()).toContain("[x] dwa");
    expect(await frame()).toContain("always on");

    await click("Save");
    expect(await done).toBeNull();
    expect(sent[0]).toMatchObject({ Read: OFF, Edit: ON, dwa: ON, github: ON });
  });

  test("more redraws the screen in place and keeps what was switched", async () => {
    const sent: Values[] = [];
    const { harness, frame, click } = await setup(screen(sent));
    harness.mockInput.pressKey(" ");
    for (let i = 0; i < 3; i++) harness.mockInput.pressArrow("down");
    expect(await frame()).toContain("→ shows more");
    harness.mockInput.pressArrow("right");
    await Bun.sleep(5);
    expect(await frame()).toContain("[x]   create_issue");
    // The switch flipped before the redraw is still flipped, and the keyboard is where it was.
    expect(await frame()).toContain("[ ] Read");
    harness.mockInput.pressKey(" ");
    expect(await frame()).toContain("[ ] github");

    // Escape leaves the wizard: the redraw did not add a screen to go back to.
    await click("Save");
    expect(sent[0]).toMatchObject({ Read: OFF, github: OFF, "github/create": ON });
  });

  test("a click on the hint of a row with more opens it", async () => {
    const { frame, click } = await setup(screen([]));
    await click("2 tools");
    await Bun.sleep(5);
    expect(await frame()).toContain("create_issue");
    expect(await frame()).toContain("[x] github");
  });
});

describe("a switch that the screen follows", () => {
  /** One switch and a note that says what it amounts to, made anew on every change. */
  function following(on: boolean): Screen {
    return {
      title: "Fix",
      values: { push: on ? ON : OFF },
      rows: [
        {
          kind: "check",
          key: "push",
          label: "allow git push",
          changed: (values) => ({ replace: following(values.push === ON) }),
        },
        { kind: "note", text: on ? "the file gets one more rule" : "nothing is applied" },
        { kind: "button", label: "Close", run: () => ({ close: true }) },
      ],
    };
  }

  test("a click on it redraws the screen from what it returns", async () => {
    const { frame, click } = await setup(following(true));
    expect(await frame()).toContain("the file gets one more rule");
    await click("allow git push");
    const after = await frame();
    expect(after).toContain("nothing is applied");
    expect(after).not.toContain("the file gets one more rule");
    await click("allow git push");
    expect(await frame()).toContain("the file gets one more rule");
  });
});
