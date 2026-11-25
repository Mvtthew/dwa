// The designer on a run in progress: the panel that shows how far a step or the run is and
// what can be done about it, opening a run, and saving changes to its steps: to the run, to
// the workflow file it was started from, or to both. Data only, like `workflow-screens.ts`.
import type { WorkflowEdit, WorkflowRunView } from "../shared/protocol.ts";
import { scopeLabel } from "../shared/scope.ts";
import { describeRun, revisionOf } from "../shared/workflow.ts";
import { conform } from "../shared/workflow-edit.ts";
import { type DesignTarget, dirty, newSession } from "./designer-model.ts";
import { stepStyle } from "./model.ts";
import type { Outcome, Row, Screen } from "./wizard.ts";
import {
  type DesignDeps,
  type DesignerHandle,
  diffNote,
  openWork,
  targetTitle,
} from "./workflow-screens.ts";

const back: Row = { kind: "button", label: "Back", run: () => ({ back: true }) };
const gap: Row = { kind: "note", text: "" };

/** Lines of a result or an error the panel shows before "Show all of it". */
const EXCERPT_LINES = 8;

/** A run as the designer has it: what the daemon last said, and whether its steps are being changed. */
export interface RunLive extends WorkflowRunView {
  editing: boolean;
}

export interface RunActions {
  /** Unlocks the steps for changes. */
  edit(): Outcome;
  /** Asks the daemon for the run as it is now and shows that. */
  reload(): Promise<void>;
  /** Puts the cursor on a step. */
  select(id: string): Outcome;
  /** Takes the cursor off the picture, back to the run as a whole. */
  deselect(): Outcome;
  close(): Outcome | Promise<Outcome>;
}

export function fetchRun(deps: DesignDeps, id: number): Promise<WorkflowRunView> {
  return deps.api.call<WorkflowRunView>("POST", "/workflows/view", { id });
}

/** Opens a run in the designer: live at first, or on the unsaved changes to its steps. */
export async function openRun(deps: DesignDeps, id: number): Promise<Outcome> {
  const live = await fetchRun(deps, id);
  const target: DesignTarget = { kind: "run", id, name: live.run.name };
  if (!live.editable) {
    // Nothing can be changed any more, so changes that were never saved are of no use.
    deps.store.clearDraft(target);
    return { view: deps.start(newSession(target, live.text), live) };
  }
  return openWork(deps, target, live.text, (session) => deps.start(session, live));
}

function textScreen(
  title: string,
  label: string,
  button: string,
  send: (text: string) => Promise<unknown>,
): Screen {
  return {
    title,
    rows: [
      { kind: "input", key: "text", label },
      {
        kind: "button",
        label: button,
        tone: "good",
        run: async (values) => {
          await send(values.text?.trim() ?? "");
          return { back: true };
        },
      },
      back,
    ],
  };
}

function excerpt(text: string): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= EXCERPT_LINES) return lines.join("\n");
  return [...lines.slice(0, EXCERPT_LINES), `… ${lines.length - EXCERPT_LINES} more lines`].join(
    "\n",
  );
}

function editRow(live: RunLive, actions: RunActions): Row[] {
  if (!live.editable) return [];
  return [
    {
      kind: "button",
      label: "Edit the steps",
      hint: "e · nothing changes in the run until you save",
      run: () => actions.edit(),
    },
  ];
}

function stepRows(
  deps: DesignDeps,
  designer: DesignerHandle,
  live: RunLive,
  id: string,
  actions: RunActions,
): Row[] {
  const { run } = live;
  const step = run.steps.find((other) => other.id === id);
  const fields = designer.design().steps.find((other) => other.id === id)?.fields ?? {};
  const role = typeof fields.role === "string" && fields.role ? fields.role : "no role";
  const post = (path: string, body: Record<string, unknown>) => async (): Promise<Outcome> => {
    await deps.api.call("POST", path, { id: run.id, step: id, ...body });
    await actions.reload();
    return { back: true };
  };
  const rows: Row[] = [{ kind: "heading", text: `STEP ${id}` }];
  if (!step) {
    rows.push({ kind: "note", text: "This step is not part of the run." });
    return rows;
  }
  const style = stepStyle(step.state);
  const facts = [
    `${style.glyph} ${style.label}${step.attempt > 1 ? `, pass ${step.attempt}` : ""}`,
    `role   ${role}`,
    ...(step.agent ? [`agent  ${step.agent}`] : []),
    ...(step.dependsOn.length > 0 ? [`after  ${step.dependsOn.join(", ")}`] : []),
  ];
  rows.push({ kind: "note", tone: style.tone, text: facts[0] ?? "" });
  rows.push({ kind: "note", text: facts.slice(1).join("\n") });
  if (step.state === "running" && step.needsAttention) {
    rows.push({
      kind: "note",
      tone: "attention",
      text: "Its agent keeps ending its turn without completing the step.",
    });
  }
  if (step.error) rows.push({ kind: "note", tone: "bad", text: excerpt(step.error) });

  if (step.state === "rejected") {
    rows.push(
      { kind: "heading", text: "IT STILL ASKS FOR CHANGES" },
      {
        kind: "button",
        label: "Another pass",
        tone: "good",
        run: post("/workflows/step/decide", { decision: "another pass" }),
      },
      {
        kind: "button",
        label: "Accept the work as it is",
        run: post("/workflows/step/decide", { decision: "accept" }),
      },
      {
        kind: "button",
        label: "Fail the run",
        tone: "bad",
        run: post("/workflows/step/decide", { decision: "fail" }),
      },
    );
  }
  if (step.state === "running") {
    rows.push(
      gap,
      {
        kind: "button",
        label: "Complete it by hand…",
        run: () => ({
          to: textScreen(
            `Complete "${id}"`,
            "Result for the steps that follow",
            "Complete the step",
            async (result) => {
              await deps.api.call("POST", "/workflows/step/complete", {
                id: run.id,
                step: id,
                result,
              });
              await actions.reload();
            },
          ),
        }),
      },
      {
        kind: "button",
        label: "Fail it…",
        tone: "bad",
        run: () => ({
          to: textScreen(`Fail "${id}"`, "Reason", "Fail the step and the run", async (reason) => {
            await deps.api.call("POST", "/workflows/step/fail", { id: run.id, step: id, reason });
            await actions.reload();
          }),
        }),
      },
    );
  }
  const { result } = step;
  if (result) {
    rows.push({ kind: "heading", text: "RESULT" }, { kind: "note", text: excerpt(result) });
    if (result.trimEnd().split("\n").length > EXCERPT_LINES) {
      rows.push({
        kind: "button",
        label: "Show all of it",
        run: () => ({
          to: { title: `Result of "${id}"`, rows: [{ kind: "note", text: result }, back] },
        }),
      });
    }
  }
  return rows;
}

/** The side panel while a run is watched: the step the cursor is on, or the run as a whole. */
export function runPanel(
  deps: DesignDeps,
  designer: DesignerHandle,
  live: RunLive,
  actions: RunActions,
): Screen {
  const { run } = live;
  const { selected } = designer.session();
  const title = `Run #${run.id} of "${run.name}": ${run.state}`;
  if (selected?.kind === "step") {
    return {
      title,
      rows: [
        ...stepRows(deps, designer, live, selected.id, actions),
        gap,
        ...editRow(live, actions),
        { kind: "button", label: "The whole run", hint: "esc", run: () => actions.deselect() },
      ],
    };
  }
  const rows: Row[] = [
    { kind: "heading", text: `RUN #${run.id} OF ${run.name}`.toUpperCase() },
    {
      kind: "note",
      tone: run.state === "failed" ? "bad" : run.state === "running" ? "good" : "muted",
      text: `${run.state}, started by ${run.startedBy}`,
    },
  ];
  if (run.input) rows.push({ kind: "note", text: excerpt(run.input) });
  if (selected?.kind === "edge") {
    rows.push({ kind: "note", text: `${selected.to} starts when ${selected.from} is done.` });
  } else if (selected?.kind === "review") {
    rows.push({
      kind: "note",
      text: `${selected.from} may send ${selected.to} back for another pass.`,
    });
  }
  const waiting = run.steps.filter((step) => step.needsAttention);
  if (waiting.length > 0) rows.push({ kind: "heading", text: "NEEDS YOU" });
  for (const step of waiting) {
    rows.push({
      kind: "button",
      label: step.id,
      hint: step.state === "rejected" ? "still asks for changes ›" : "its agent stopped short ›",
      tone: "attention",
      run: () => actions.select(step.id),
    });
  }
  rows.push(gap, ...editRow(live, actions), {
    kind: "button",
    label: "Show the results",
    run: async () => {
      await actions.reload();
      return {
        to: {
          title: `Results of run #${run.id}`,
          rows: [
            { kind: "note", text: describeRun((await fetchRun(deps, run.id)).run, true) },
            back,
          ],
        },
      };
    },
  });
  if (run.state === "running") {
    rows.push({
      kind: "button",
      label: "Cancel the run…",
      tone: "bad",
      run: () => ({
        to: {
          title: `Cancel run #${run.id}?`,
          rows: [
            { kind: "note", text: "Its agents are stopped and nothing further starts." },
            {
              kind: "button",
              label: "Yes, cancel the run",
              tone: "bad",
              run: async () => {
                await deps.api.call("POST", "/workflows/cancel", { id: run.id });
                await actions.reload();
                return { back: true };
              },
            },
            back,
          ],
        },
      }),
    });
  }
  rows.push(gap, { kind: "button", label: "Close", hint: "q", run: () => actions.close() });
  return { title, rows };
}

/**
 * Saving changes to a run's steps. Says what they do to the run first, then asks where they
 * go: this run, the workflow file it was started from, or both. `applied` is told what the
 * run has afterwards.
 */
export async function runSaveScreen(
  deps: DesignDeps,
  designer: DesignerHandle,
  applied: (view: WorkflowRunView) => void,
): Promise<Screen> {
  const session = designer.session();
  const { target } = session;
  if (target.kind !== "run") throw new Error("This is not a run.");
  const { definition, problems } = designer.design();
  if (problems.length > 0 || !definition) {
    throw new Error(
      `Not saved: ${problems.length === 1 ? "one thing is" : `${problems.length} things are`} still wrong. ${problems[0]?.message ?? ""}`,
    );
  }
  if (!dirty(session)) throw new Error("Nothing was changed.");
  const edit = (preview: boolean) =>
    deps.api.call<WorkflowEdit>("POST", "/workflows/edit", {
      id: target.id,
      definition: session.text,
      preview,
      base: revisionOf(session.base),
    });
  const preview = await edit(true);

  // The file a new run of this name would use.
  const file = deps.store
    .list()
    .find((workflow) => workflow.name === target.name && !workflow.hidden);
  let fileNow = "";
  let fileNext: string | null = null;
  let fileNote = `There is no workflow file "${target.name}" any more; only the run can take the changes.`;
  if (file) {
    try {
      fileNow = deps.store.read(file);
      fileNext = conform(fileNow, definition, session.renames);
      fileNote =
        fileNext === fileNow
          ? `The ${scopeLabel(file.source)} workflow file already says this.`
          : "";
      if (fileNext === fileNow) fileNext = null;
    } catch (error) {
      fileNext = null;
      fileNote = `The workflow file cannot take these changes: ${(error as Error).message}`;
    }
  }

  const toRun = async (): Promise<string[]> => {
    const result = await edit(false);
    deps.store.clearDraft(target);
    applied(await fetchRun(deps, target.id));
    return result.changes.length > 0
      ? [`Run #${target.id} now:`, ...result.changes.map((change) => `- ${change}`)]
      : [`Run #${target.id} is as it was.`];
  };
  const toFile = (): string[] => {
    if (!file || fileNext === null) return [];
    const version = deps.store.save(file, fileNext);
    return [
      `Workflow ${file.name} (${scopeLabel(file.source)}) is at v${version}. Runs started from now on use it.`,
    ];
  };
  const done = (lines: string[]): Outcome => ({
    to: {
      title: "Saved",
      rows: [
        { kind: "note", text: lines.join("\n") },
        { kind: "button", label: "Back to the run", run: () => ({ back: true }) },
      ],
    },
  });

  const rows: Row[] = [
    {
      kind: "note",
      text: [
        "What this does to the run:",
        ...(preview.changes.length > 0
          ? preview.changes.map((change) => `- ${change}`)
          : ["- nothing: the run already has these steps"]),
      ].join("\n"),
    },
  ];
  if (preview.restarts) {
    rows.push({
      kind: "note",
      tone: "attention",
      text: "Work that was already started is thrown away: see the lines above.",
    });
  }
  rows.push({
    kind: "button",
    label: "Apply to this run",
    hint: "the workflow file stays as it is",
    tone: "good",
    run: async () => done(await toRun()),
  });
  if (file && fileNext !== null) {
    rows.push(
      {
        kind: "button",
        label: "Apply to this run and save to the workflow file",
        hint: "later runs get the changes too",
        tone: "good",
        // The file first: when it cannot be written, the run is left alone.
        run: async () => {
          const saved = toFile();
          return done([...(await toRun()), ...saved]);
        },
      },
      {
        kind: "button",
        label: "Save to the workflow file only",
        hint: "this run goes on as it is; your changes to it stay unsaved",
        run: () =>
          done([...toFile(), `Run #${target.id} was not changed; your changes are still here.`]),
      },
    );
  }
  // The choice first; what exactly changes is below it for whoever wants to read it.
  rows.push(back, gap);
  rows.push(diffNote("What changes in the run's steps:", session.base, session.text));
  if (file && fileNext !== null) {
    rows.push(
      diffNote(
        `What would change in the ${scopeLabel(file.source)} workflow file:`,
        fileNow,
        fileNext,
      ),
    );
  } else {
    rows.push({ kind: "note", text: fileNote });
  }
  return { title: `Save the steps of ${targetTitle(target)}`, rows };
}
