import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowEdit, WorkflowRunInfo, WorkflowRunView } from "../src/shared/protocol.ts";
import { formatWorkflow, parseWorkflow, revisionOf } from "../src/shared/workflow.ts";
import {
  apply,
  type DesignTarget,
  newSession,
  type Session,
  view as viewOf,
} from "../src/ui/designer-model.ts";
import {
  openRun,
  type RunActions,
  type RunLive,
  runPanel,
  runSaveScreen,
} from "../src/ui/run-screens.ts";
import type { Outcome, Row, Screen } from "../src/ui/wizard.ts";
import { type DesignDeps, type DesignerHandle, draftOf } from "../src/ui/workflow-screens.ts";
import { diskWorkflowStore } from "../src/ui/workflow-store.ts";

const FEATURE = join(import.meta.dir, "..", "examples", "workflows", "feature.toml");

function step(id: string, state: WorkflowRunInfo["steps"][number]["state"]) {
  return {
    id,
    state,
    attempt: state === "rejected" ? 2 : 1,
    dependsOn: [],
    agent: state === "running" ? `${id}-agent` : null,
    result: state === "done" ? `${id} result` : null,
    error: null,
    needsAttention: state === "rejected",
  };
}

const RUN: WorkflowRunInfo = {
  id: 2,
  name: "feature",
  input: "add a button",
  state: "running",
  startedBy: "user",
  createdAt: 0,
  finishedAt: null,
  steps: [step("explore", "done"), step("build", "running"), step("review", "rejected")],
};

function buttons(screen: Screen) {
  const found = new Map<string, Extract<Row, { kind: "button" }>>();
  for (const row of screen.rows) if (row.kind === "button") found.set(row.label, row);
  return found;
}

async function press(screen: Screen, label: string, values: Record<string, string> = {}) {
  const button = buttons(screen).get(label);
  if (!button) throw new Error(`no "${label}" in: ${[...buttons(screen).keys()].join(", ")}`);
  return button.run(values);
}

async function next(screen: Screen, label: string): Promise<Screen> {
  const outcome = await press(screen, label);
  if (!("to" in outcome)) throw new Error(`"${label}" does not lead to a screen`);
  return outcome.to;
}

const notes = (screen: Screen) =>
  screen.rows.flatMap((row) => (row.kind === "note" ? [row.text] : [])).join("\n");

describe("the designer's screens for a run", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A project with the feature workflow, and a daemon that has run #2 of it. */
  function setup(run: WorkflowRunInfo = RUN) {
    dir = mkdtempSync(join(tmpdir(), "dwa-run-screens-"));
    const project = join(dir, "project");
    mkdirSync(join(project, ".dwa", "workflows"), { recursive: true });
    cpSync(FEATURE, join(project, ".dwa", "workflows", "feature.toml"));
    const file = () => readFileSync(join(project, ".dwa", "workflows", "feature.toml"), "utf8");
    const text = formatWorkflow(parseWorkflow(file(), "feature"));
    const state = { run, text };
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const live = (): WorkflowRunView => ({
      run: state.run,
      text: state.text,
      revision: revisionOf(state.text),
      editable: state.run.state === "running",
    });
    const started: Session[] = [];
    const deps: DesignDeps = {
      api: {
        roles: [],
        profiles: [],
        call: async <T>(_method: string, path: string, body?: unknown) => {
          const input = (body ?? {}) as Record<string, unknown>;
          calls.push({ path, body: input });
          if (path === "/workflows/view") return live() as T;
          if (path === "/workflows/edit") {
            if (input.base !== revisionOf(state.text)) throw new Error("changed meanwhile");
            if (!input.preview) state.text = String(input.definition);
            const edit: WorkflowEdit = {
              run: state.run,
              changes: ['changed "build"'],
              restarts: true,
              applied: !input.preview,
            };
            return edit as T;
          }
          return state.run as T;
        },
      },
      store: diskWorkflowStore(project, null, { XDG_CONFIG_HOME: join(dir, "home") }),
      start: (session) => {
        started.push(session);
        return async () => ({ close: true });
      },
      home: () => ({ title: "home", rows: [] }),
    };
    const target: DesignTarget = { kind: "run", id: 2, name: "feature" };
    let session = newSession(target, text);
    const designer: DesignerHandle = {
      session: () => session,
      design: () => viewOf(session.text, "feature", state.run),
      apply: (op) => {
        session = apply(session, op);
      },
      set: (nextSession) => {
        session = nextSession;
      },
      undo: () => undefined,
      redo: () => undefined,
    };
    const done: string[] = [];
    const actions: RunActions = {
      edit: () => {
        done.push("edit");
        return { back: true };
      },
      reload: async () => {
        done.push("reload");
      },
      select: (id) => {
        done.push(`select ${id}`);
        return { back: true };
      },
      deselect: () => ({ back: true }),
      close: () => ({ close: true }),
    };
    const watched = (): RunLive => ({ ...live(), editing: false });
    return { deps, designer, actions, done, calls, state, file, watched, started, target, text };
  }

  test("the run as a whole: what needs the user, editing, results and cancelling", async () => {
    const { deps, designer, actions, done, calls, watched } = setup();
    const screen = runPanel(deps, designer, watched(), actions);
    expect(screen.title).toBe('Run #2 of "feature": running');
    expect([...buttons(screen).keys()]).toEqual([
      "review",
      "Edit the steps",
      "Show the results",
      "Cancel the run…",
      "Close",
    ]);
    expect(notes(screen)).toContain("running, started by user");
    expect(notes(screen)).toContain("add a button");

    await press(screen, "review");
    await press(screen, "Edit the steps");
    expect(done).toEqual(["select review", "edit"]);

    const results = await next(screen, "Show the results");
    expect(notes(results)).toContain("      explore result");

    expect(await press(await next(screen, "Cancel the run…"), "Yes, cancel the run")).toEqual({
      back: true,
    });
    expect(calls.at(-1)).toEqual({ path: "/workflows/cancel", body: { id: 2 } });
    expect(done.at(-1)).toBe("reload");
  });

  test("a running step can be completed or failed by hand, and shows its agent", async () => {
    const { deps, designer, actions, done, calls, watched } = setup();
    designer.set({ ...designer.session(), selected: { kind: "step", id: "build" } });
    const screen = runPanel(deps, designer, watched(), actions);
    expect(notes(screen)).toContain("● running");
    expect(notes(screen)).toContain("role   developer");
    expect(notes(screen)).toContain("agent  build-agent");
    expect([...buttons(screen).keys()]).toEqual([
      "Complete it by hand…",
      "Fail it…",
      "Edit the steps",
      "The whole run",
    ]);
    const complete = await next(screen, "Complete it by hand…");
    expect(await press(complete, "Complete the step", { text: " built by hand " })).toEqual({
      back: true,
    });
    await press(await next(screen, "Fail it…"), "Fail the step and the run", { text: "wrong" });
    expect(calls).toEqual([
      { path: "/workflows/step/complete", body: { id: 2, step: "build", result: "built by hand" } },
      { path: "/workflows/step/fail", body: { id: 2, step: "build", reason: "wrong" } },
    ]);
    expect(done).toEqual(["reload", "reload"]);
  });

  test("a review that still asks for changes waits for a decision; a done step shows its result", async () => {
    const { deps, designer, actions, calls, watched } = setup();
    designer.set({ ...designer.session(), selected: { kind: "step", id: "review" } });
    const review = runPanel(deps, designer, watched(), actions);
    expect(notes(review)).toContain("◆ needs you, pass 2");
    await press(review, "Another pass");
    await press(review, "Accept the work as it is");
    await press(review, "Fail the run");
    expect(calls.map((call) => call.body.decision)).toEqual(["another pass", "accept", "fail"]);
    expect(calls[0]).toEqual({
      path: "/workflows/step/decide",
      body: { id: 2, step: "review", decision: "another pass" },
    });

    designer.set({ ...designer.session(), selected: { kind: "step", id: "explore" } });
    const explore = runPanel(deps, designer, watched(), actions);
    expect(notes(explore)).toContain("explore result");
    expect([...buttons(explore).keys()]).toEqual(["Edit the steps", "The whole run"]);
  });

  test("a finished run can be looked at only", () => {
    const over = { ...RUN, state: "done" as const, steps: [step("explore", "done")] };
    const { deps, designer, actions, watched } = setup(over);
    const screen = runPanel(deps, designer, watched(), actions);
    expect([...buttons(screen).keys()]).toEqual(["Show the results", "Close"]);
  });

  test("saving is refused while nothing changed or something is wrong", async () => {
    const { deps, designer } = setup();
    await expect(runSaveScreen(deps, designer, () => undefined)).rejects.toThrow(
      "Nothing was changed.",
    );
    designer.apply({ op: "setFields", id: "build", changes: { role: "nobody-has-this" } });
    designer.apply({ op: "setFields", id: "build", changes: { prompt: "" } });
    await expect(runSaveScreen(deps, designer, () => undefined)).rejects.toThrow("Not saved:");
  });

  test("changes go to the run alone, and the file stays as it is", async () => {
    const { deps, designer, calls, state, file, target } = setup();
    const before = file();
    designer.apply({
      op: "setFields",
      id: "build",
      changes: { prompt: "Build it well: {{input}}\n" },
    });
    deps.store.putDraft(draftOf(designer.session()));
    const applied: WorkflowRunView[] = [];
    const screen = await runSaveScreen(deps, designer, (now) => applied.push(now));
    expect(calls[0]?.body).toMatchObject({ id: 2, preview: true });
    expect(notes(screen)).toContain('- changed "build"');
    expect(notes(screen)).toContain("Work that was already started is thrown away");
    expect(notes(screen)).toContain("What would change in the project workflow file:");
    expect([...buttons(screen).keys()]).toEqual([
      "Apply to this run",
      "Apply to this run and save to the workflow file",
      "Save to the workflow file only",
      "Back",
    ]);

    const saved = await next(screen, "Apply to this run");
    expect(notes(saved)).toContain("Run #2 now:");
    expect(state.text).toContain("Build it well");
    expect(applied[0]?.text).toBe(state.text);
    expect(file()).toBe(before);
    expect(deps.store.draft(target)).toBeNull();
  });

  test("changes go to the run and the file, which keeps its comments and gets a version", async () => {
    const { deps, designer, state, file } = setup();
    designer.apply({ op: "renameStep", from: "build", to: "implement" });
    designer.apply({
      op: "addStep",
      id: "docs",
      fields: { role: "developer", prompt: "Document {{steps.implement.result}}\n" },
      below: "review",
    });
    const screen = await runSaveScreen(deps, designer, () => undefined);
    const saved = await next(screen, "Apply to this run and save to the workflow file");
    expect(notes(saved)).toContain("Workflow feature (project) is at v2.");
    expect(state.text).toContain("[steps.implement]");

    const text = file();
    expect(text).toContain("# Explore, build, review.");
    expect(text).toContain("[steps.implement]");
    expect(text).not.toContain("[steps.build]");
    const definition = parseWorkflow(text, "feature");
    expect(definition).toEqual(parseWorkflow(state.text, "feature"));
    expect(definition.steps.review?.reviews).toBe("implement");
    const history = deps.store.history({ name: "feature", source: "project" });
    expect(history.current).toBe(2);
  });

  test("changes can go to the file only; the run and the unsaved work stay", async () => {
    const { deps, designer, calls, state, file, text } = setup();
    designer.apply({ op: "setFields", id: "review", changes: { max_rounds: 5 } });
    const screen = await runSaveScreen(deps, designer, () => {
      throw new Error("the run must not be touched");
    });
    const saved = await next(screen, "Save to the workflow file only");
    expect(notes(saved)).toContain("Run #2 was not changed");
    expect(file()).toContain("max_rounds = 5");
    expect(state.text).toBe(text);
    expect(calls.filter((call) => call.path === "/workflows/edit" && !call.body.preview)).toEqual(
      [],
    );
    expect(designer.session().text).toContain("max_rounds = 5");
  });

  test("without the workflow file only the run is offered", async () => {
    const { deps, designer } = setup();
    deps.store.remove({ name: "feature", source: "project" });
    designer.apply({ op: "setFields", id: "review", changes: { max_rounds: 5 } });
    const screen = await runSaveScreen(deps, designer, () => undefined);
    expect([...buttons(screen).keys()]).toEqual(["Apply to this run", "Back"]);
    expect(notes(screen)).toContain('There is no workflow file "feature" any more');
  });

  test("a run opens live; unsaved changes to its steps are offered again", async () => {
    const { deps, started, target, text } = setup();
    const outcome: Outcome = await openRun(deps, 2);
    expect("view" in outcome).toBe(true);

    const changed = apply(newSession(target, text), {
      op: "setFields",
      id: "review",
      changes: { max_rounds: 5 },
    });
    deps.store.putDraft(draftOf(changed));
    const again = await openRun(deps, 2);
    if (!("to" in again)) throw new Error("the unsaved work was not offered");
    expect(again.to.title).toBe("Unsaved work on run #2 of feature");
    await press(again.to, "Continue where I left off");
    expect(started.at(-1)?.text).toContain("max_rounds = 5");
    expect(started.at(-1)?.base).toBe(text);
  });

  test("a run that is over drops unsaved changes to its steps", async () => {
    const { deps, started, target, text } = setup({ ...RUN, state: "cancelled" });
    writeFileSync(join(dir, "x"), "");
    deps.store.putDraft(
      draftOf(
        apply(newSession(target, text), {
          op: "setFields",
          id: "review",
          changes: { max_rounds: 5 },
        }),
      ),
    );
    const outcome = await openRun(deps, 2);
    expect("view" in outcome).toBe(true);
    expect(started.at(-1)?.text).toBe(text);
    expect(deps.store.draft(target)).toBeNull();
  });
});
