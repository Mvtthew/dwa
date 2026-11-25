import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import type { WorkflowEdit, WorkflowRunInfo, WorkflowRunView } from "../src/shared/protocol.ts";
import { formatWorkflow, parseWorkflow, revisionOf } from "../src/shared/workflow.ts";
import { createDesigner, type Designer } from "../src/ui/designer.ts";
import { openRun } from "../src/ui/run-screens.ts";
import { createWizard } from "../src/ui/wizard.ts";
import { type DesignDeps, designListScreen } from "../src/ui/workflow-screens.ts";
import { diskWorkflowStore } from "../src/ui/workflow-store.ts";

const EXAMPLES = join(import.meta.dir, "..", "examples");

function step(
  id: string,
  state: WorkflowRunInfo["steps"][number]["state"],
  attempt = 1,
): WorkflowRunInfo["steps"][number] {
  return {
    id,
    state,
    attempt,
    dependsOn: [],
    agent: state === "running" ? `${id}-1` : null,
    result: state === "done" ? `${id} result` : null,
    error: null,
    needsAttention: state === "rejected",
  };
}

describe("the designer on a run", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const work of cleanup.splice(0)) work();
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "dwa-designer-run-"));
    const project = join(dir, "project");
    mkdirSync(join(project, ".dwa", "workflows"), { recursive: true });
    cpSync(join(EXAMPLES, "roles"), join(project, ".dwa", "roles"), { recursive: true });
    const path = join(project, ".dwa", "workflows", "feature.toml");
    cpSync(join(EXAMPLES, "workflows", "feature.toml"), path);
    const harness = await createTestRenderer({ width: 110, height: 36 });
    cleanup.push(() => {
      harness.renderer.destroy();
      rmSync(dir, { recursive: true, force: true });
    });
    const state = {
      text: formatWorkflow(parseWorkflow(readFileSync(path, "utf8"), "feature")),
      run: {
        id: 7,
        name: "feature",
        input: "add a button",
        state: "running",
        startedBy: "user",
        createdAt: 0,
        finishedAt: null,
        steps: [step("explore", "done"), step("build", "running", 2), step("review", "pending")],
      } as WorkflowRunInfo,
    };
    const edits: Record<string, unknown>[] = [];
    let designer: Designer | null = null;
    const deps: DesignDeps = {
      api: {
        roles: [],
        profiles: [],
        call: async <T>(_method: string, route: string, body?: unknown) => {
          const input = (body ?? {}) as Record<string, unknown>;
          if (route === "/workflows/view") {
            const view: WorkflowRunView = {
              run: state.run,
              text: state.text,
              revision: revisionOf(state.text),
              editable: state.run.state === "running",
            };
            return view as T;
          }
          if (route === "/workflows/edit") {
            edits.push(input);
            if (input.base !== revisionOf(state.text)) throw new Error("changed meanwhile");
            if (!input.preview) state.text = String(input.definition);
            const edit: WorkflowEdit = {
              run: state.run,
              changes: ['removed "review"'],
              restarts: false,
              applied: !input.preview,
            };
            return edit as T;
          }
          throw new Error(`no route ${route}`);
        },
      },
      store: diskWorkflowStore(project, null, { XDG_CONFIG_HOME: join(dir, "home") }),
      start: (session, live) => {
        designer = createDesigner({ ...deps, checkEvery: 20 }, session, live);
        return designer.view;
      },
      home: () => designListScreen(deps),
    };
    void createWizard(harness.renderer, designListScreen(deps), await openRun(deps, 7));
    const frame = async (wait = 10) => {
      await Bun.sleep(wait);
      await harness.renderOnce();
      return harness.captureCharFrame();
    };
    const key = async (name: string, shift = false) => {
      harness.mockInput.pressKey(name, { shift });
      return frame();
    };
    const steps = () => (designer as Designer | null)?.design().steps.map((one) => one.id) ?? [];
    return { harness, frame, key, state, edits, steps, file: () => readFileSync(path, "utf8") };
  }

  test("shows how far every step is, and follows the run", async () => {
    const { frame, state } = await setup();
    let text = await frame();
    expect(text).toContain("Workflow run #7 of feature");
    expect(text).toContain("running · 3 steps · live · e edits the steps");
    expect(text).toContain("✓ explore");
    expect(text).toContain("● build");
    expect(text).toContain("#2");
    expect(text).toContain("build-1");
    expect(text).toContain("○ review");
    expect(text).toContain("RUN #7 OF FEATURE");
    expect(text).toContain("Run #7 is running: 1 of 3 steps done, 1 running.");

    state.run = {
      ...state.run,
      steps: [step("explore", "done"), step("build", "done", 2), step("review", "rejected")],
    };
    text = await frame(80);
    expect(text).toContain("✓ build");
    expect(text).toContain("◆ review");
    expect(text).toContain("NEEDS YOU");
    expect(text).toContain("1 waiting for your decision");
  });

  test("the steps are locked until e, and a change is saved to the run", async () => {
    const { harness, frame, key, state, edits, steps, file } = await setup();
    const before = file();
    for (let i = 0; i < 3; i++) {
      harness.mockInput.pressArrow("down");
      await frame();
    }
    let text = await key("x");
    expect(text).toContain("Press e to change the steps of this run.");
    expect(steps()).toEqual(["explore", "build", "review"]);

    text = await key("e");
    expect(text).toContain("editing · nothing changed yet");
    text = await key("x");
    expect(steps()).toEqual(["explore", "build"]);
    expect(text).toContain("unsaved changes (kept as a draft)");
    // Leaving the editing with changes is refused; they would be lost without a word.
    expect(await key("e")).toContain("Save or undo your changes first.");

    text = await key("s");
    expect(text).toContain("What this does to the run:");
    expect(text).toContain('- removed "review"');
    expect(text).toContain("Apply to this run");
    harness.mockInput.pressEnter();
    text = await frame(30);
    expect(text).toContain("Run #7 now:");
    expect(edits.map((edit) => edit.preview)).toEqual([true, false]);
    expect(state.text).not.toContain("[steps.review]");
    expect(file()).toBe(before);

    harness.mockInput.pressEnter();
    text = await frame(60);
    expect(text).toContain("live · e edits the steps");
    expect(steps()).toEqual(["explore", "build"]);
  });

  test("a run that ended can only be looked at", async () => {
    const { frame, key, state } = await setup();
    state.run = { ...state.run, state: "cancelled" };
    let text = await frame(80);
    expect(text).toContain("cancelled · 3 steps · its steps can no longer be changed");
    text = await key("e");
    expect(text).toContain("This run is cancelled; its steps can no longer be changed.");
  });

  test("a change made to the run elsewhere while editing is pointed out", async () => {
    const { frame, key, state } = await setup();
    await key("e");
    state.text = state.text.replace("max_rounds = 3", "max_rounds = 4");
    let text = await frame(80);
    expect(text).toContain("THE RUN CHANGED ELSEWHERE: f shows what");
    text = await key("f");
    expect(text).toContain("The run has changed");
    expect(text).toContain("max_rounds = 4");
  });
});
