// The screens around the workflow designer: the list of workflows, starting a new one, the
// side panel for what is selected on the picture, saving, history, and what to do with unsaved
// work or a file that changed underneath. Data only; the picture is drawn by `designer.ts`.
import { CAPABILITY_KEYS, EFFORT_LEVELS } from "../shared/capabilities.ts";
import { MARKS } from "../shared/diagram.ts";
import { diffLines } from "../shared/history.ts";
import type { RoleFields } from "../shared/role-edit.ts";
import { scopeLabel } from "../shared/scope.ts";
import { DEFAULT_MAX_ROUNDS, validWorkflowName } from "../shared/workflow.ts";
import type { StepChanges } from "../shared/workflow-edit.ts";
import {
  type DesignTarget,
  type DesignView,
  dirty,
  freeStepName,
  newSession,
  type Op,
  type Session,
  type StepView,
} from "./designer-model.ts";
import { historyScreen, nameScreen, type RoleStore, roleScreen } from "./role-screens.ts";
import { moveLabel, scopeHint, scopeRow, scopeTitle, scopeValue } from "./scope-rows.ts";
import { OFF, ON, type Outcome, type Row, type Screen, type Values, type View } from "./wizard.ts";
import type { WizardApi } from "./wizards.ts";
import type { Draft, WorkflowStore } from "./workflow-store.ts";

const back: Row = { kind: "button", label: "Back", run: () => ({ back: true }) };
const close: Row = { kind: "button", label: "Close", run: () => ({ close: true }) };
const gap: Row = { kind: "note", text: "" };

/** The designer as its screens use it: the work in hand and a way to change it. */
export interface DesignerHandle {
  session(): Session;
  design(): DesignView;
  /** Makes a change; throws with the reason when it cannot be made. */
  apply(op: Op): void;
  /** Replaces the work in hand: after a save, a switch of version, a reload. */
  set(session: Session): void;
  undo(): void;
  redo(): void;
}

/** What the screens need besides the designer. */
export interface DesignDeps {
  api: WizardApi;
  store: WorkflowStore;
  /** Opens the designer on a piece of work; the view to hand the popup to. */
  start(session: Session): View;
  /** The list to return to when the designer is closed. */
  home(): Screen | Promise<Screen>;
}

export function targetTitle(target: DesignTarget): string {
  return target.kind === "run"
    ? `run #${target.id} of ${target.name}`
    : scopeTitle(target.name, target.source);
}

function sessionFrom(draft: Draft, base: string): Session {
  return {
    target: draft.target,
    base,
    text: draft.text,
    undo: draft.undo,
    redo: draft.redo,
    selected: null,
    renames: draft.renames,
  };
}

/** The draft a session is kept as. */
export function draftOf(session: Session, now: Date = new Date()): Draft {
  return {
    v: 1,
    target: session.target,
    base: session.base,
    text: session.text,
    undo: session.undo,
    redo: session.redo,
    renames: session.renames,
    savedAt: now.toISOString(),
  };
}

function diffNote(heading: string, from: string, to: string): Row {
  const lines = diffLines(from, to);
  return {
    kind: "note",
    text: [heading, ...(lines.length > 0 ? lines : ["No differences."])].join("\n"),
  };
}

/**
 * Opens a workflow file in the designer. Unsaved work from an earlier time comes first: it is
 * offered again, with what changed in the file since when something did.
 */
export function openDesign(deps: DesignDeps, target: DesignTarget & { kind: "file" }): Outcome {
  const text = target.fresh ? "" : deps.store.read(target);
  const draft = deps.store.draft(target);
  if (!draft || draft.text === text) {
    if (draft) deps.store.clearDraft(target);
    return { view: deps.start(newSession(target, text)) };
  }
  const stale = draft.base !== text;
  const when = draft.savedAt.slice(0, 16).replace("T", " ");
  return {
    to: {
      title: `Unsaved work on ${targetTitle(target)}`,
      rows: [
        {
          kind: "note",
          text: `There are changes from ${when} that were not saved.`,
        },
        ...(stale
          ? [
              {
                kind: "note" as const,
                tone: "attention" as const,
                text: "The file has changed since then. Continuing keeps your changes; saving them makes a\nnew version on top, and the file's own changes stay in its history.",
              },
              diffNote("What changed in the file:", draft.base, text),
            ]
          : []),
        diffNote("Your unsaved changes:", draft.base, draft.text),
        {
          kind: "button",
          label: "Continue where I left off",
          tone: "good",
          run: () => ({ view: deps.start(sessionFrom(draft, text)) }),
        },
        {
          kind: "button",
          label: "Drop them and start from the file",
          tone: "bad",
          run: () => {
            deps.store.clearDraft(target);
            return { view: deps.start(newSession(target, text)) };
          },
        },
        back,
      ],
    },
  };
}

function checkNewName(store: WorkflowStore, name: string): void {
  if (!name) throw new Error("Type a name first.");
  if (!validWorkflowName(name)) {
    throw new Error("A name uses letters, digits, - and _ (up to 40).");
  }
  if (store.list().some((workflow) => workflow.name === name)) {
    throw new Error(`There is already a workflow "${name}".`);
  }
}

/** Starting a new workflow: empty, from one that dwa ships, or as a copy. */
export function newWorkflowScreen(deps: DesignDeps): Screen {
  const { store } = deps;
  const named = (values: Values) => {
    const name = values.name?.trim() ?? "";
    checkNewName(store, name);
    return { name, source: scopeValue(values) };
  };
  const rows: Row[] = [
    { kind: "input", key: "name", label: "Name", placeholder: "letters, digits, - and _" },
    scopeRow("workflow"),
    { kind: "heading", text: "START FROM" },
    {
      kind: "button",
      label: "An empty workflow",
      hint: "add the steps on the picture; the file is written when you save",
      tone: "good",
      run: (values) => {
        const target = { kind: "file" as const, ...named(values), fresh: true };
        return openDesign(deps, target);
      },
    },
  ];
  for (const template of store.templates()) {
    rows.push({
      kind: "button",
      label: `Template: ${template.name}`,
      hint: template.description,
      run: (values) => {
        const target = named(values);
        store.create(target.name, template.text, target.source);
        return openDesign(deps, { kind: "file", ...target });
      },
    });
  }
  const existing = store.list().filter((workflow) => !workflow.error);
  if (existing.length > 0) rows.push(gap, { kind: "heading", text: "OR A COPY OF" });
  for (const workflow of existing) {
    rows.push({
      kind: "button",
      label: workflow.name,
      hint: [scopeHint(workflow, "workflow"), workflow.description].filter(Boolean).join(" · "),
      run: (values) => {
        const target = named(values);
        store.duplicate(workflow, target.name, target.source);
        return openDesign(deps, { kind: "file", ...target });
      },
    });
  }
  rows.push(gap, back);
  return { title: "New workflow", rows };
}

/** The workflows to design, and a way to start one. */
export function designListScreen(deps: DesignDeps): Screen {
  const rows: Row[] = [];
  const workflows = deps.store.list();
  if (workflows.length === 0) rows.push({ kind: "note", text: "No workflows yet." });
  for (const workflow of workflows) {
    const where = scopeHint(workflow, "workflow");
    rows.push({
      kind: "button",
      label: workflow.name,
      hint: workflow.error
        ? `${where} · cannot be run yet: ${workflow.error}`
        : [where, workflow.description ?? workflow.steps.join(" → ")].filter(Boolean).join(" · "),
      tone: workflow.error ? "attention" : undefined,
      run: () => openDesign(deps, { kind: "file", name: workflow.name, source: workflow.source }),
    });
  }
  rows.push(
    gap,
    {
      kind: "button",
      label: "New workflow…",
      tone: "good",
      run: () => ({ to: newWorkflowScreen(deps) }),
    },
    close,
  );
  return { title: "Workflow designer", rows };
}

/** A list to pick one of; `done` gets the value picked. */
function pickScreen(
  title: string,
  note: string,
  options: { value: string; label: string; hint?: string }[],
  current: string,
  done: (value: string) => Outcome,
): Screen {
  return {
    title,
    rows: [
      ...(note ? [{ kind: "note" as const, text: note }] : []),
      ...options.map(
        (option): Row => ({
          kind: "button",
          label: `${option.value === current ? "*" : " "} ${option.label}`,
          hint: option.hint,
          run: () => done(option.value),
        }),
      ),
      gap,
      back,
    ],
  };
}

const MODELS = ["opus", "sonnet", "haiku"];
const INHERIT = "";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A new step: its name, then the role it runs as. Where it goes is the caller's to say. */
export function addStepScreen(
  designer: DesignerHandle,
  store: WorkflowStore,
  place: { below?: string | null; edge?: { from: string; to: string } },
): Screen {
  const create = (values: Values, role: string): Outcome => {
    const id = values.name?.trim() ?? "";
    if (!id) throw new Error("Type a name first.");
    designer.apply({
      op: "addStep",
      id,
      fields: role ? { role } : {},
      below: place.edge ? null : (place.below ?? null),
    });
    if (place.edge) designer.apply({ op: "drop", id, slot: { kind: "edge", ...place.edge } });
    return { back: true };
  };
  const where = place.edge
    ? `It goes between ${place.edge.from} and ${place.edge.to}.`
    : place.below
      ? `It starts when ${place.below} is done.`
      : "It depends on nothing yet; put it in place on the picture.";
  return {
    title: "New step",
    values: { name: freeStepName(designer.design()) },
    rows: [
      { kind: "note", text: `${where}\nIts prompt is written in the panel afterwards.` },
      { kind: "input", key: "name", label: "Name", placeholder: "letters, digits, - and _" },
      { kind: "heading", text: "THE ROLE IT RUNS AS" },
      ...store.choices().roles.map(
        (role): Row => ({
          kind: "button",
          label: role,
          tone: "good",
          run: (values) => create(values, role),
        }),
      ),
      {
        kind: "button",
        label: "No role",
        hint: "the defaults only",
        run: (values) => create(values, ""),
      },
      gap,
      back,
    ],
  };
}

/** The steps a step depends on, as switches. Steps that come after it are not offered. */
function dependsScreen(designer: DesignerHandle, step: StepView): Screen {
  const design = designer.design();
  const others = design.steps.filter(
    (other) => other.id !== step.id && !design.ancestors[other.id]?.includes(step.id),
  );
  const values: Values = {};
  for (const other of others) values[other.id] = step.dependsOn.includes(other.id) ? ON : OFF;
  return {
    title: `${step.id} starts after`,
    values,
    rows: [
      {
        kind: "note",
        text: "The step starts when every ticked step is done. Steps that come after it are not listed.",
      },
      ...others.map((other): Row => ({ kind: "check", key: other.id, label: other.id })),
      gap,
      {
        kind: "button",
        label: "Apply",
        tone: "good",
        run: (current) => {
          const names = others.map((other) => other.id).filter((id) => current[id] === ON);
          designer.apply({ op: "setFields", id: step.id, changes: { depends_on: names } });
          return { back: true };
        },
      },
      back,
    ],
  };
}

/** Whether a step reviews an earlier one, and after how many passes the user is asked. */
function reviewScreen(designer: DesignerHandle, step: StepView): Screen {
  const design = designer.design();
  const earlier = design.steps.filter(
    (other) => other.id !== step.id && !design.ancestors[other.id]?.includes(step.id),
  );
  const rounds = typeof step.fields.max_rounds === "number" ? step.fields.max_rounds : undefined;
  return {
    title: `What ${step.id} reviews`,
    values: { rounds: String(rounds ?? DEFAULT_MAX_ROUNDS) },
    rows: [
      {
        kind: "note",
        text: "A review step may send the reviewed step back for another pass instead of completing.\nAfter the passes below you are asked what to do.",
      },
      { kind: "input", key: "rounds", label: "Passes before you are asked", placeholder: "3" },
      { kind: "heading", text: "IT REVIEWS" },
      ...earlier.map(
        (other): Row => ({
          kind: "button",
          label: `${other.id === step.reviews ? "*" : " "} ${other.id}`,
          hint: design.ancestors[step.id]?.includes(other.id)
            ? undefined
            : "also makes it depend on that step",
          run: (values) => {
            const passes = Number(values.rounds?.trim() || DEFAULT_MAX_ROUNDS);
            if (!Number.isInteger(passes) || passes < 1) {
              throw new Error("The passes are a whole number, 1 or more.");
            }
            designer.apply({
              op: "makeReview",
              reviewer: step.id,
              target: other.id,
              rounds: passes === DEFAULT_MAX_ROUNDS && rounds === undefined ? undefined : passes,
            });
            return { back: true };
          },
        }),
      ),
      {
        kind: "button",
        label: `${step.reviews ? " " : "*"} Nothing: an ordinary step`,
        run: () => {
          if (step.reviews || rounds !== undefined) {
            designer.apply({ op: "clearReview", reviewer: step.id });
          }
          return { back: true };
        },
      },
      gap,
      back,
    ],
  };
}

/** Everything a step's session may use, in the form the role settings have for a role. */
function stepSettingsScreen(deps: DesignDeps, designer: DesignerHandle, step: StepView): Screen {
  const fields: RoleFields = {};
  for (const key of CAPABILITY_KEYS) {
    if (step.fields[key] !== undefined) (fields as Record<string, unknown>)[key] = step.fields[key];
  }
  const refuse = () => {
    throw new Error("A step is not a role file.");
  };
  const choices = deps.store.choices();
  // The role form, shown for a step: it only loads and saves, into the workflow's text.
  const store: RoleStore = {
    list: () => [],
    load: () => fields,
    save: (_role, changes) => {
      designer.apply({ op: "setFields", id: step.id, changes: changes as StepChanges });
      return 0;
    },
    create: refuse,
    duplicate: refuse,
    rename: refuse,
    move: refuse,
    remove: refuse,
    users: () => [],
    warnings: () => [],
    history: () => ({ current: null, versions: [] }),
    diff: () => [],
    switchTo: refuse,
    choices: () => choices,
  };
  return roleScreen(deps.api, store, step.id, undefined, {
    title: `Settings of step ${step.id}`,
    word: "step",
    done: () => ({ back: true }),
  });
}

/** What the panel can ask the designer to do with the picture. */
export interface PanelActions {
  /** Picks the step up, to put it down somewhere else. */
  move(id: string): Outcome;
  /** Starts drawing a line from the step. */
  link(id: string): Outcome;
  /** Opens the step's prompt in the user's editor. */
  editPrompt(id: string): Outcome | Promise<Outcome>;
  save(): Outcome | Promise<Outcome>;
  close(): Outcome | Promise<Outcome>;
  /** Takes the cursor off the picture, back to the workflow as a whole. */
  deselect(): Outcome;
}

/** Keys of the panel's values the designer listens to while they are typed or switched. */
export const PANEL = { prompt: "prompt", keep: "keep", description: "description" } as const;

function problemNote(read: () => string[]): Row {
  return {
    kind: "note",
    tone: "bad",
    // Room for two; the footer lists them all.
    text: "\n",
    live: () => read().slice(0, 2).join("\n"),
  };
}

function stepPanel(
  deps: DesignDeps,
  designer: DesignerHandle,
  step: StepView,
  actions: PanelActions,
): Screen {
  const { fields } = step;
  const choices = deps.store.choices();
  const design = designer.design();
  const set = (changes: StepChanges): Outcome => {
    designer.apply({ op: "setFields", id: step.id, changes });
    return { back: true };
  };
  const value = (key: string, none = "inherit") => text(fields[key]) || none;
  const rounds = typeof fields.max_rounds === "number" ? fields.max_rounds : DEFAULT_MAX_ROUNDS;
  const own = CAPABILITY_KEYS.filter(
    (key) => key !== "model" && key !== "effort" && fields[key] !== undefined,
  ).length;
  const rows: Row[] = [
    { kind: "heading", text: `STEP ${step.id}` },
    problemNote(() =>
      (designer.design().steps.find((other) => other.id === step.id)?.problems ?? []).map(
        (problem) => problem.message,
      ),
    ),
    {
      kind: "button",
      label: "Name",
      hint: `${step.id} ›`,
      run: () => ({
        to: {
          ...nameScreen(
            `Rename step ${step.id}`,
            "Steps that depend on it, a review of it and prompts that use its result follow the new name.",
            "Rename",
            (to) => {
              designer.apply({ op: "renameStep", from: step.id, to });
              return { back: true };
            },
          ),
          values: { name: step.id },
        },
      }),
    },
    {
      kind: "button",
      label: "Role",
      hint: `${value("role", "none")} ›`,
      run: () => ({
        to: pickScreen(
          `Role of ${step.id}`,
          "The role says what the step's session may use and gives it its instructions.",
          [
            { value: INHERIT, label: "No role", hint: "the defaults only" },
            ...[
              ...new Set([...choices.roles, ...(text(fields.role) ? [text(fields.role)] : [])]),
            ].map((role) => ({ value: role, label: role })),
          ],
          text(fields.role),
          (role) => set({ role: role || null }),
        ),
      }),
    },
    {
      kind: "button",
      label: "Model",
      hint: `${value("model")} ›`,
      run: () => ({
        to: {
          ...pickScreen(
            `Model of ${step.id}`,
            "Without one, the role's model is used.",
            [
              { value: INHERIT, label: "Inherit" },
              ...MODELS.map((model) => ({ value: model, label: model })),
            ],
            text(fields.model),
            (model) => set({ model: model || null }),
          ),
        },
      }),
    },
    {
      kind: "button",
      label: "Effort",
      hint: `${value("effort")} ›`,
      run: () => ({
        to: pickScreen(
          `Effort of ${step.id}`,
          "Without one, the role's effort is used.",
          [
            { value: INHERIT, label: "Inherit" },
            ...EFFORT_LEVELS.map((level) => ({ value: level, label: level })),
          ],
          text(fields.effort),
          (effort) => set({ effort: (effort || null) as StepChanges["effort"] }),
        ),
      }),
    },
  ];
  if (choices.profiles.length > 0 || fields.profile !== undefined) {
    rows.push({
      kind: "button",
      label: "Profile",
      hint: `${value("profile")} ›`,
      run: () => ({
        to: pickScreen(
          `Profile of ${step.id}`,
          "The Claude command the step's session is started with.",
          [
            { value: INHERIT, label: "Inherit" },
            ...choices.profiles.map((name) => ({ value: name, label: name })),
          ],
          text(fields.profile),
          (profile) => set({ profile: profile || null }),
        ),
      }),
    });
  }
  rows.push(
    {
      kind: "button",
      label: "Starts after",
      hint: `${step.dependsOn.join(", ") || "nothing: at the start"} ›`,
      run: () => ({ to: dependsScreen(designer, step) }),
    },
    {
      kind: "button",
      label: "Reviews",
      hint: `${step.reviews ? `${step.reviews}, up to ${rounds} passes` : "nothing"} ›`,
      run: () => ({ to: reviewScreen(designer, step) }),
    },
    {
      kind: "check",
      key: PANEL.keep,
      label: "Keeps its agent",
      hint: "the session stays open when the step is done",
    },
    {
      kind: "text",
      key: PANEL.prompt,
      label: "Prompt",
      height: 8,
      inserts: [
        { label: "input", text: "{{input}}" },
        ...(design.ancestors[step.id] ?? []).map((id) => ({
          label: id,
          text: `{{steps.${id}.result}}`,
        })),
      ],
    },
    {
      kind: "button",
      label: "Open the prompt in $EDITOR",
      run: () => actions.editPrompt(step.id),
    },
    {
      kind: "button",
      label: "More settings…",
      hint: own > 0 ? `${own} set here ${MARKS.ownSettings}` : "tools, MCP, plugins, skills, rules",
      run: () => ({ to: stepSettingsScreen(deps, designer, step) }),
    },
    gap,
    { kind: "button", label: "Move it…", hint: "m", run: () => actions.move(step.id) },
    { kind: "button", label: "Draw a line from it…", hint: "c", run: () => actions.link(step.id) },
    {
      kind: "button",
      label: "Add a step after it…",
      hint: "a",
      run: () => ({ to: addStepScreen(designer, deps.store, { below: step.id }) }),
    },
    {
      kind: "button",
      label: "Delete the step",
      hint: "what follows it is joined to what came before",
      tone: "bad",
      run: () => {
        designer.apply({ op: "removeStep", id: step.id });
        return actions.deselect();
      },
    },
    { kind: "button", label: "The whole workflow", hint: "esc", run: () => actions.deselect() },
  );
  return {
    title: step.id,
    rows,
    values: {
      [PANEL.keep]: fields.keep_agent === true ? ON : OFF,
      [PANEL.prompt]: text(fields.prompt),
    },
  };
}

function workflowPanel(deps: DesignDeps, designer: DesignerHandle, actions: PanelActions): Screen {
  const session = designer.session();
  const { target } = session;
  const design = designer.design();
  const rows: Row[] = [
    { kind: "heading", text: targetTitle(target).toUpperCase() },
    problemNote(() =>
      designer
        .design()
        .problems.filter((problem) => !problem.step)
        .map((problem) => problem.message),
    ),
    { kind: "input", key: PANEL.description, label: "Description", placeholder: "one line" },
    {
      kind: "button",
      label: "Add a step…",
      hint: "a",
      tone: "good",
      run: () => ({
        to: addStepScreen(designer, deps.store, { below: design.steps.at(-1)?.id ?? null }),
      }),
    },
    { kind: "button", label: "Save…", hint: "s", tone: "good", run: () => actions.save() },
    {
      kind: "button",
      label: "Undo",
      hint: "u",
      run: () => {
        designer.undo();
        return { back: true };
      },
    },
    {
      kind: "button",
      label: "Redo",
      hint: "U",
      run: () => {
        designer.redo();
        return { back: true };
      },
    },
  ];
  if (target.kind === "file" && !target.fresh) {
    const saved = (): void => {
      if (dirty(designer.session())) throw new Error("Save or undo your changes first.");
    };
    rows.push(
      gap,
      {
        kind: "button",
        label: "History…",
        run: () => {
          saved();
          return {
            to: historyScreen({
              name: target.name,
              history: () => deps.store.history(target),
              diff: (from, to) => deps.store.diff(target, from, to),
              switchTo: (n) => {
                deps.store.switchTo(target, n);
                designer.set(newSession(target, deps.store.read(target)));
              },
              switched: (n) =>
                `Workflow ${target.name} is at v${n} now. Runs already started keep their own copy.`,
            }),
          };
        },
      },
      {
        kind: "button",
        label: "Rename…",
        run: () => {
          saved();
          return {
            to: nameScreen(
              `Rename ${target.name}`,
              [
                "Runs already started keep the old name.",
                ...deps.store.warnings("rename", target),
              ].join("\n"),
              "Rename",
              (to) => {
                deps.store.rename(target, to);
                const renamed = { ...target, name: to };
                designer.set(newSession(renamed, deps.store.read(renamed)));
                return { back: true };
              },
            ),
          };
        },
      },
      {
        kind: "button",
        label: "Duplicate…",
        run: () => {
          saved();
          return {
            to: nameScreen(
              `Copy of ${target.name}`,
              "The new workflow starts as an exact copy.",
              "Create",
              (to, where) => {
                deps.store.duplicate(target, to, where);
                const copy = { kind: "file" as const, name: to, source: where };
                designer.set(newSession(copy, deps.store.read(copy)));
                return { back: true };
              },
              target.source,
            ),
          };
        },
      },
      {
        kind: "button",
        label: moveLabel(target.source),
        run: () => {
          saved();
          const to = target.source === "user" ? "project" : "user";
          return {
            to: {
              title: `Move ${target.name}`,
              rows: [
                {
                  kind: "note",
                  text: [
                    to === "user"
                      ? "The file goes to your personal dwa folder and leaves the project."
                      : "The file goes into the project, for everyone who uses it.",
                    "Its history moves with it, and the name stays.",
                    ...deps.store.warnings("move", target),
                  ].join("\n"),
                },
                {
                  kind: "button",
                  label:
                    to === "user" ? "Move it to my personal folder" : "Move it into the project",
                  tone: "good",
                  run: () => {
                    deps.store.move(target, to);
                    const moved = { ...target, source: to } as typeof target;
                    designer.set(newSession(moved, deps.store.read(moved)));
                    return { back: true };
                  },
                },
                back,
              ],
            },
          };
        },
      },
      {
        kind: "button",
        label: "Delete…",
        tone: "bad",
        run: () => ({
          to: {
            title: `Delete ${target.name}?`,
            rows: [
              {
                kind: "note",
                text: [
                  "The file is removed. Its versions stay in the history folder.",
                  ...deps.store.warnings("delete", target),
                ].join("\n"),
              },
              {
                kind: "button",
                label: "Yes, delete it",
                tone: "bad",
                run: async () => {
                  deps.store.remove(target);
                  deps.store.clearDraft(target);
                  return { home: await deps.home() };
                },
              },
              back,
            ],
          },
        }),
      },
    );
  }
  rows.push(gap, { kind: "button", label: "Close", hint: "q", run: () => actions.close() });
  return {
    title: targetTitle(target),
    rows,
    values: { [PANEL.description]: design.description },
  };
}

/** The side panel: the step or line the cursor is on, or the workflow as a whole. */
export function panelScreen(
  deps: DesignDeps,
  designer: DesignerHandle,
  actions: PanelActions,
): Screen {
  const { selected } = designer.session();
  const design = designer.design();
  if (selected?.kind === "step") {
    const step = design.steps.find((other) => other.id === selected.id);
    if (step) return stepPanel(deps, designer, step, actions);
  }
  if (selected?.kind === "edge") {
    const { from, to } = selected;
    return {
      title: `${from} → ${to}`,
      rows: [
        { kind: "heading", text: `LINE ${from} → ${to}` },
        { kind: "note", text: `${to} starts when ${from} is done.` },
        {
          kind: "button",
          label: "Put a new step here…",
          tone: "good",
          run: () => ({ to: addStepScreen(designer, deps.store, { edge: { from, to } }) }),
        },
        {
          kind: "button",
          label: "Remove this line",
          hint: `${to} no longer waits for ${from}`,
          tone: "bad",
          run: () => {
            designer.apply({ op: "disconnect", from, to });
            return actions.deselect();
          },
        },
        { kind: "button", label: "The whole workflow", hint: "esc", run: () => actions.deselect() },
      ],
    };
  }
  if (selected?.kind === "review") {
    const { from, to } = selected;
    const step = design.steps.find((other) => other.id === from);
    return {
      title: `${from} reviews ${to}`,
      rows: [
        { kind: "heading", text: `REVIEW ${from} ↺ ${to}` },
        {
          kind: "note",
          text: `${from} may send ${to} back for another pass instead of completing.`,
        },
        ...(step
          ? [
              {
                kind: "button" as const,
                label: "Change what it reviews, or the passes…",
                run: (): Outcome => ({ to: reviewScreen(designer, step) }),
              },
            ]
          : []),
        {
          kind: "button",
          label: "Stop reviewing",
          hint: `${from} becomes an ordinary step`,
          tone: "bad",
          run: () => {
            designer.apply({ op: "clearReview", reviewer: from });
            return actions.deselect();
          },
        },
        { kind: "button", label: "The whole workflow", hint: "esc", run: () => actions.deselect() },
      ],
    };
  }
  return workflowPanel(deps, designer, actions);
}

/**
 * Saving a workflow file: what will change, then the write. Refused while something is wrong
 * with the workflow; the unsaved work stays as it is until then.
 */
export function saveScreen(deps: DesignDeps, designer: DesignerHandle): Screen {
  const session = designer.session();
  const { target } = session;
  if (target.kind !== "file") throw new Error("This is not a workflow file.");
  const problems = designer.design().problems;
  if (problems.length > 0) {
    throw new Error(
      `Not saved: ${problems.length === 1 ? "one thing is" : `${problems.length} things are`} still wrong. ${problems[0]?.message ?? ""}`,
    );
  }
  if (!dirty(session) && !target.fresh) throw new Error("Nothing was changed.");
  const where = scopeLabel(target.source);
  return {
    title: `Save ${targetTitle(target)}`,
    rows: [
      target.fresh
        ? { kind: "note", text: `A new ${where} workflow file is written.` }
        : diffNote("What changes in the file:", session.base, session.text),
      {
        kind: "button",
        label: target.fresh ? "Create the workflow" : "Save",
        tone: "good",
        run: () => {
          let version = 1;
          if (target.fresh) deps.store.create(target.name, session.text, target.source);
          else version = deps.store.save(target, session.text);
          deps.store.clearDraft(target);
          const saved = { kind: "file" as const, name: target.name, source: target.source };
          designer.set(newSession(saved, deps.store.read(saved)));
          return {
            to: {
              title: "Saved",
              rows: [
                {
                  kind: "note",
                  text: `Workflow ${target.name} is at v${version}.\nRuns started from now on use it; runs in progress keep their own copy.`,
                },
                { kind: "button", label: "Back to the designer", run: () => ({ back: true }) },
                {
                  kind: "button",
                  label: "To the list of workflows",
                  run: async () => ({ home: await deps.home() }),
                },
                close,
              ],
            },
          };
        },
      },
      back,
    ],
  };
}

/** The file changed while it was open here: look, then keep the work or take the file's text. */
export function staleScreen(designer: DesignerHandle, fileText: string): Screen {
  const session = designer.session();
  return {
    title: "The file has changed",
    rows: [
      {
        kind: "note",
        tone: "attention",
        text: "Someone, or an agent, changed this workflow's file while you had it open here.",
      },
      diffNote("What changed in the file:", session.base, fileText),
      {
        kind: "button",
        label: "Keep my changes",
        hint: "saving makes a new version on top; the file's changes stay in its history",
        tone: "good",
        run: () => {
          designer.set({ ...session, base: fileText });
          return { back: true };
        },
      },
      {
        kind: "button",
        label: "Drop mine and load the file",
        tone: "bad",
        run: () => {
          designer.set(newSession(session.target, fileText));
          return { back: true };
        },
      },
      back,
    ],
  };
}

/** Leaving with unsaved work: it is kept as a draft, so this only says so. */
export function closeScreen(deps: DesignDeps, designer: DesignerHandle): Screen {
  const { target } = designer.session();
  return {
    title: "Unsaved changes",
    rows: [
      {
        kind: "note",
        text: "Your changes are kept as a draft and offered again when you open this workflow.\nNothing is written to the workflow until you save.",
      },
      {
        kind: "button",
        label: "Leave them as a draft",
        tone: "good",
        run: async () => ({ home: await deps.home() }),
      },
      {
        kind: "button",
        label: "Drop the changes",
        tone: "bad",
        run: async () => {
          deps.store.clearDraft(target);
          designer.set(newSession(target, designer.session().base));
          return { home: await deps.home() };
        },
      },
      back,
    ],
  };
}
