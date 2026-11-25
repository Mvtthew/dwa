// The workflow designer without a screen: what is being edited, every change as one step that
// can be taken back, and what the picture and the side panel show. The workflow's text is the
// thing that is edited, so comments in a file survive and a state to return to is just a text.
import {
  type DiagramInput,
  type DiagramStep,
  MARKS,
  type Region,
  type Slot,
} from "../shared/diagram.ts";
import type { Scope } from "../shared/scope.ts";
import {
  checkWorkflow,
  type WorkflowDefinition,
  type WorkflowProblem,
} from "../shared/workflow.ts";
import {
  addStep,
  clearReview,
  connect,
  disconnect,
  insertOnEdge,
  looseSteps,
  makeReview,
  placeBelow,
  placeBeside,
  removeStep,
  renameStep,
  type StepChanges,
  type StepFields,
  setDescription,
  setStepFields,
} from "../shared/workflow-edit.ts";

/** What a designer works on: a workflow file, or the copy a run in progress works from. */
export type DesignTarget =
  /** `fresh`: not written yet; the first save creates the file. */
  | { kind: "file"; name: string; source: Scope; fresh?: boolean }
  | { kind: "run"; id: number; name: string };

export interface Session {
  target: DesignTarget;
  /** The text the changes are counted from: the file's, or the run's copy. */
  base: string;
  text: string;
  /** Earlier texts, the latest last, and the ones taken back. */
  undo: string[];
  redo: string[];
  /** What the cursor is on: a step or a line. */
  selected: Region | null;
  /** Steps renamed here, by the name they had in `base`, so a file can follow a run's renames. */
  renames: Record<string, string>;
}

/** States kept to go back to. */
export const UNDO_LIMIT = 200;

export type Op =
  /** A new step; with `below` it depends on that step. */
  | { op: "addStep"; id: string; fields: StepFields; below?: string | null }
  | { op: "removeStep"; id: string }
  | { op: "renameStep"; from: string; to: string }
  | { op: "setFields"; id: string; changes: StepChanges }
  | { op: "setDescription"; description: string | null }
  /** `to` depends on `from`. */
  | { op: "connect"; from: string; to: string }
  | { op: "disconnect"; from: string; to: string }
  | { op: "makeReview"; reviewer: string; target: string; rounds?: number }
  | { op: "clearReview"; reviewer: string }
  /** Puts a step down somewhere else. */
  | { op: "drop"; id: string; slot: Slot }
  /** The whole text at once: from an editor, or a file that changed underneath. */
  | { op: "replaceText"; text: string };

export function newSession(target: DesignTarget, text: string): Session {
  return { target, base: text, text, undo: [], redo: [], selected: null, renames: {} };
}

function edit(text: string, op: Op): string {
  switch (op.op) {
    case "addStep": {
      const added = addStep(text, op.id, op.fields);
      return op.below ? placeBelow(added, op.id, op.below) : added;
    }
    case "removeStep":
      return removeStep(text, op.id);
    case "renameStep":
      return renameStep(text, op.from, op.to);
    case "setFields":
      return setStepFields(text, op.id, op.changes);
    case "setDescription":
      return setDescription(text, op.description);
    case "connect":
      return connect(text, op.from, op.to);
    case "disconnect":
      return disconnect(text, op.from, op.to);
    case "makeReview":
      return makeReview(text, op.reviewer, op.target, op.rounds);
    case "clearReview":
      return clearReview(text, op.reviewer);
    case "drop":
      return op.slot.kind === "edge"
        ? insertOnEdge(text, op.id, op.slot.from, op.slot.to)
        : op.slot.kind === "beside"
          ? placeBeside(text, op.id, op.slot.step)
          : placeBelow(text, op.id, op.slot.step);
    case "replaceText":
      return op.text;
  }
}

/** The steps a text has, or none when it cannot be read at all. */
function stepIds(text: string): string[] {
  try {
    return Object.keys(looseSteps(text));
  } catch {
    return [];
  }
}

function stillThere(selected: Region | null, text: string): Region | null {
  if (!selected || selected.kind === "slot") return null;
  const ids = stepIds(text);
  if (selected.kind === "step") return ids.includes(selected.id) ? selected : null;
  return ids.includes(selected.from) && ids.includes(selected.to) ? selected : null;
}

/**
 * Makes one change. A change that cannot be made (a name that is taken, a dependency that
 * would go round in a loop) throws with the reason and leaves the session as it was.
 */
export function apply(session: Session, op: Op): Session {
  const text = edit(session.text, op);
  if (text === session.text) return session;
  const renames = { ...session.renames };
  let selected = session.selected;
  if (op.op === "renameStep") {
    const first = Object.keys(renames).find((name) => renames[name] === op.from) ?? op.from;
    if (first === op.to) delete renames[first];
    else renames[first] = op.to;
    selected = { kind: "step", id: op.to };
  } else if (op.op === "addStep") {
    selected = { kind: "step", id: op.id };
  } else if (op.op === "drop") {
    selected = { kind: "step", id: op.id };
  }
  return {
    ...session,
    text,
    undo: [...session.undo, session.text].slice(-UNDO_LIMIT),
    redo: [],
    selected: stillThere(selected, text),
    renames,
  };
}

/**
 * Like a change, but one that goes on from the change before it instead of adding a state to
 * go back to: typing in a field is taken back as one piece.
 */
export function applyMore(session: Session, op: Op): Session {
  const next = apply(session, op);
  return next === session ? session : { ...next, undo: session.undo };
}

export function undo(session: Session): Session {
  const text = session.undo.at(-1);
  if (text === undefined) return session;
  return {
    ...session,
    text,
    undo: session.undo.slice(0, -1),
    redo: [...session.redo, session.text],
    selected: stillThere(session.selected, text),
  };
}

export function redo(session: Session): Session {
  const text = session.redo.at(-1);
  if (text === undefined) return session;
  return {
    ...session,
    text,
    undo: [...session.undo, session.text],
    redo: session.redo.slice(0, -1),
    selected: stillThere(session.selected, text),
  };
}

export function dirty(session: Session): boolean {
  return session.text !== session.base;
}

/** One step as the side panel shows it: what the text has, valid or not. */
export interface StepView {
  id: string;
  dependsOn: string[];
  reviews?: string;
  fields: Record<string, unknown>;
  problems: WorkflowProblem[];
}

export interface DesignView {
  /** The steps in file order. */
  steps: StepView[];
  description: string;
  problems: WorkflowProblem[];
  /** The workflow when nothing is wrong with it. */
  definition: WorkflowDefinition | null;
  /** The picture's input. Empty when the text cannot be read as TOML. */
  input: DiagramInput;
  /** For every step, the steps it depends on directly or through others. */
  ancestors: Record<string, string[]>;
}

const OWN_SETTINGS = [
  "profile",
  "model",
  "effort",
  "permission_mode",
  "tools",
  "deny_tools",
  "allow",
  "deny",
  "mcp",
  "plugins",
  "skills",
  "off_mcp",
  "off_plugins",
  "off_skills",
  "memory",
];

/** What a text shows as. A text with mistakes is still drawn, as far as it can be read. */
export function view(text: string, name: string): DesignView {
  const { definition, problems } = checkWorkflow(text, name);
  let loose: ReturnType<typeof looseSteps> = {};
  let description = "";
  try {
    loose = looseSteps(text);
    const raw = (Bun.TOML.parse(text) as { description?: unknown }).description;
    description = typeof raw === "string" ? raw : "";
  } catch {
    // Not TOML: nothing to draw; the problems say why.
  }
  const steps: StepView[] = Object.entries(loose).map(([id, step]) => ({
    id,
    dependsOn: step.depends_on,
    reviews: step.reviews,
    fields: step.fields,
    problems: problems.filter((problem) => problem.step === id),
  }));
  const ancestors: Record<string, string[]> = {};
  for (const step of steps) {
    const seen = new Set<string>();
    const walk = (id: string) => {
      for (const dependency of loose[id]?.depends_on ?? []) {
        if (seen.has(dependency)) continue;
        seen.add(dependency);
        walk(dependency);
      }
    };
    walk(step.id);
    ancestors[step.id] = [...seen];
  }
  const input: DiagramInput = {
    steps: steps.map((step): DiagramStep => {
      const { fields } = step;
      const own = OWN_SETTINGS.some((key) => fields[key] !== undefined);
      const wrong = step.problems.length > 0;
      return {
        id: step.id,
        dependsOn: step.dependsOn,
        reviews: step.reviews,
        rounds: typeof fields.max_rounds === "number" ? fields.max_rounds : undefined,
        detail: typeof fields.role === "string" && fields.role ? fields.role : "no role",
        mark: wrong ? MARKS.problem : undefined,
        note:
          `${fields.keep_agent === true ? MARKS.keepsAgent : ""}${own ? MARKS.ownSettings : ""}` ||
          undefined,
        tone: wrong ? "bad" : undefined,
      };
    }),
  };
  return { steps, description, problems, definition, input, ancestors };
}

/**
 * What joining two steps means, from which one the line was drawn to which: down to a later
 * step makes that step depend on this one; up to an earlier step makes this one a review of it.
 * `layers` is each step's row in the picture, the top one 0.
 */
export function linkOp(
  design: DesignView,
  layers: Record<string, number>,
  from: string,
  to: string,
): Op | null {
  if (from === to) return null;
  const up = (layers[to] ?? 0) < (layers[from] ?? 0);
  if (up || design.ancestors[from]?.includes(to)) {
    return { op: "makeReview", reviewer: from, target: to };
  }
  return { op: "connect", from, to };
}

/** A name for a new step that no step has yet: "step", "step-2", ... */
export function freeStepName(design: DesignView, wanted = "step"): string {
  const taken = new Set(design.steps.map((step) => step.id));
  if (!taken.has(wanted)) return wanted;
  let n = 2;
  while (taken.has(`${wanted}-${n}`)) n += 1;
  return `${wanted}-${n}`;
}
