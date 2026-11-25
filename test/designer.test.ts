import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { createDesigner, type Designer } from "../src/ui/designer.ts";
import { createWizard } from "../src/ui/wizard.ts";
import { type DesignDeps, designListScreen, openDesign } from "../src/ui/workflow-screens.ts";
import { diskWorkflowStore } from "../src/ui/workflow-store.ts";

const EXAMPLES = join(import.meta.dir, "..", "examples");

describe("the designer on screen", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const step of cleanup.splice(0)) step();
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "dwa-designer-"));
    const project = join(dir, "project");
    mkdirSync(join(project, ".dwa", "workflows"), { recursive: true });
    cpSync(join(EXAMPLES, "roles"), join(project, ".dwa", "roles"), { recursive: true });
    cpSync(
      join(EXAMPLES, "workflows", "feature.toml"),
      join(project, ".dwa", "workflows", "feature.toml"),
    );
    const harness = await createTestRenderer({ width: 110, height: 36 });
    cleanup.push(() => {
      harness.renderer.destroy();
      rmSync(dir, { recursive: true, force: true });
    });
    let designer: Designer | null = null;
    const deps: DesignDeps = {
      api: {
        call: async () => {
          throw new Error("no daemon");
        },
        roles: [],
        profiles: [],
      },
      store: diskWorkflowStore(project, null, { XDG_CONFIG_HOME: join(dir, "home") }),
      start: (session) => {
        designer = createDesigner(deps, session);
        return designer.view;
      },
      home: () => designListScreen(deps),
    };
    void createWizard(
      harness.renderer,
      designListScreen(deps),
      openDesign(deps, { kind: "file", name: "feature", source: "project" }),
    );
    const frame = async () => {
      await Bun.sleep(10);
      await harness.renderOnce();
      return harness.captureCharFrame().split("\n");
    };
    /** Where `text` is shown: a cell a little inside it. */
    const at = async (text: string): Promise<[number, number]> => {
      const lines = await frame();
      const y = lines.findIndex((line) => line.includes(text));
      if (y === -1) throw new Error(`"${text}" is not on screen:\n${lines.join("\n")}`);
      return [(lines[y] ?? "").indexOf(text) + 2, y];
    };
    const key = async (name: string, shift = false) => {
      harness.mockInput.pressKey(name, { shift });
      await frame();
    };
    const steps = () =>
      (designer as Designer | null)
        ?.design()
        .steps.map((step) => `${step.id}<-${step.dependsOn.join(",")}`) ?? [];
    const file = () => readFileSync(join(project, ".dwa", "workflows", "feature.toml"), "utf8");
    return {
      harness,
      frame,
      at,
      key,
      steps,
      file,
      session: () => (designer as Designer).session(),
    };
  }

  test("shows the picture, the panel and the keys", async () => {
    const { frame } = await setup();
    const text = (await frame()).join("\n");
    expect(text).toContain("Workflow feature (project)");
    expect(text).toContain("│ explore   │");
    expect(text).toContain("◀─×3─╮");
    expect(text).toContain("FEATURE (PROJECT)");
    expect(text).toContain("Nothing is wrong with this workflow.");
  });

  test("a click selects a step and the panel follows", async () => {
    const { harness, frame, at, session } = await setup();
    await harness.mockMouse.click(...(await at("│ review")));
    expect(session().selected).toEqual({ kind: "step", id: "review" });
    const text = (await frame()).join("\n");
    expect(text).toContain("STEP review");
    expect(text).toContain("│▌review");
  });

  test("the arrows move over the steps and del removes one, which u takes back", async () => {
    const { harness, frame, key, steps, session } = await setup();
    harness.mockInput.pressArrow("down");
    await frame();
    harness.mockInput.pressArrow("down");
    await frame();
    expect(session().selected).toEqual({ kind: "step", id: "build" });
    await key("x");
    // What followed the removed step is joined to what came before it.
    expect(steps()).toEqual(["explore<-", "review<-explore"]);
    await key("u");
    expect(steps()).toEqual(["explore<-", "build<-explore", "review<-build"]);
  });

  test("dragging a step onto a later one makes that one wait for it", async () => {
    const { harness, frame, at, steps } = await setup();
    const from = await at("│ explore");
    const to = await at("│ review");
    await harness.mockMouse.drag(...from, ...to);
    await frame();
    expect(steps()).toEqual(["explore<-", "build<-explore", "review<-build,explore"]);
  });

  test("dragging a step onto a marked place moves it there", async () => {
    const { harness, frame, at, steps } = await setup();
    const from = await at("│ review");
    await harness.mockMouse.pressDown(...from);
    await harness.mockMouse.emitMouseEvent("drag", from[0] + 20, from[1]);
    // The places it can go are marked while it is carried; the first is next to explore.
    const lines = await frame();
    const y = lines.findIndex((line) => line.includes("◆"));
    const x = (lines[y] ?? "").indexOf("◆");
    await harness.mockMouse.emitMouseEvent("drag", x, y);
    await harness.mockMouse.release(x, y);
    await frame();
    expect(steps()).toEqual(["explore<-", "review<-", "build<-explore"]);
  });

  test("m picks a step up and enter puts it down at the marked place", async () => {
    const { harness, frame, key, steps } = await setup();
    for (let i = 0; i < 3; i++) {
      harness.mockInput.pressArrow("down");
      await frame();
    }
    await key("m");
    expect((await frame()).join("\n")).toContain("marks where review can go");
    harness.mockInput.pressEnter();
    await frame();
    expect(steps()).toEqual(["explore<-", "review<-", "build<-explore"]);
  });

  test("unsaved work is kept as a draft and nothing is written until it is saved", async () => {
    const { harness, frame, key, file, session } = await setup();
    const before = file();
    harness.mockInput.pressArrow("down");
    await frame();
    await key("x");
    expect(file()).toBe(before);
    expect((await frame()).join("\n")).toContain("unsaved changes (kept as a draft)");
    expect(session().undo).toHaveLength(1);
  });
});
