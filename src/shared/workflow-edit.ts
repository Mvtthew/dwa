// Every change dwa makes to a workflow file. The changes to the text keep the rest of the file
// as it is, comments included, so the text can be the thing an editor works on: each function
// takes a workflow text and returns the next one. The functions that write record a version.
// `formatWorkflow` writes a whole text afresh and is for a run's own copy only.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CAPABILITY_KEYS, ConfigError } from "./capabilities.ts";
import {
  BY_HAND,
  moveHistory,
  record,
  saveTracked,
  switchTo,
  type Tracked,
  type Version,
  versionText,
} from "./history.ts";
import {
  type ItemEntry,
  moveItem,
  requireItem,
  type Scope,
  type ScopeContext,
  trackedEntry,
} from "./scope.ts";
import {
  addTable,
  mapValues,
  moveTable,
  removeTable,
  renameTable,
  replaceInValue,
  setKeys,
  type TomlValue,
  tableOrder,
} from "./toml.ts";
import {
  listAllWorkflows,
  parseWorkflow,
  validWorkflowName,
  type WorkflowDefinition,
  type WorkflowStep,
  workflowKind,
} from "./workflow.ts";

/** A step's keys as they are written in the file. */
export type StepFields = Partial<WorkflowStep>;

/** Values to set; `null` removes the key from the step. */
export type StepChanges = { [K in keyof StepFields]?: StepFields[K] | null };

/** A workflow by name (the one a run uses), or by place and name. */
export type WorkflowRef = string | { name: string; source?: Scope };

/** The prompt reads best at the end of a step. */
const LAST_KEYS = ["prompt"];

/** The keys a step can have, in the order a new step gets them. */
const STEP_KEYS = [
  "role",
  "profile",
  ...CAPABILITY_KEYS,
  "depends_on",
  "reviews",
  "max_rounds",
  "keep_agent",
  "prompt",
] as const;

const table = (id: string) => `steps.${id}`;

/** A step as the text has it, without the checks and defaults of a finished workflow. */
interface LooseStep {
  depends_on: string[];
  reviews?: string;
  prompt?: string;
  fields: Record<string, unknown>;
}

/** The steps of a text that parses as TOML, valid workflow or not, in file order. */
export function looseSteps(text: string): Record<string, LooseStep> {
  const raw = (Bun.TOML.parse(text) as { steps?: Record<string, unknown> }).steps ?? {};
  const steps: Record<string, LooseStep> = {};
  for (const id of tableOrder(text, "steps")) {
    const value = raw[id];
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const fields = value as Record<string, unknown>;
    const names = Array.isArray(fields.depends_on) ? fields.depends_on : [];
    steps[id] = {
      depends_on: names.filter((name): name is string => typeof name === "string"),
      reviews: typeof fields.reviews === "string" ? fields.reviews : undefined,
      prompt: typeof fields.prompt === "string" ? fields.prompt : undefined,
      fields,
    };
  }
  return steps;
}

function requireStep(steps: Record<string, LooseStep>, id: string): LooseStep {
  const step = steps[id];
  if (!step) throw new ConfigError(`There is no step "${id}".`);
  return step;
}

function checkStepName(id: string): void {
  if (!validWorkflowName(id)) {
    throw new ConfigError(
      `"${id}" cannot be a step name: use letters, digits, - and _ (up to 40).`,
    );
  }
}

/** The steps `id` depends on, directly or through others. A loop in the text ends the walk. */
function before(steps: Record<string, LooseStep>, id: string): Set<string> {
  const seen = new Set<string>();
  const walk = (at: string) => {
    for (const dependency of steps[at]?.depends_on ?? []) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      walk(dependency);
    }
  };
  walk(id);
  return seen;
}

function tomlChanges(changes: StepChanges): Record<string, TomlValue | undefined> {
  const out: Record<string, TomlValue | undefined> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    // What the file leaves out means the same as these, so they are not written.
    const absent =
      value === null ||
      (key === "depends_on" && Array.isArray(value) && value.length === 0) ||
      (key === "keep_agent" && value === false);
    out[key] = absent ? undefined : (value as TomlValue);
  }
  // The two tool lists are one choice: a step that gets one loses the other.
  if (changes.tools != null && !("deny_tools" in changes)) out.deny_tools = undefined;
  if (changes.deny_tools != null && !("tools" in changes)) out.tools = undefined;
  return out;
}

/** Sets, or with `null` removes, keys of one step. */
export function setStepFields(text: string, id: string, changes: StepChanges): string {
  requireStep(looseSteps(text), id);
  return setKeys(text, table(id), tomlChanges(changes), LAST_KEYS);
}

function setDepends(text: string, id: string, names: string[]): string {
  return setStepFields(text, id, { depends_on: [...new Set(names)] });
}

/**
 * Adds a step before the step `before`, or at the end. A new step may still lack a prompt;
 * the text then says what is missing when it is checked.
 */
export function addStep(
  text: string,
  id: string,
  fields: StepFields,
  beforeStep: string | null = null,
): string {
  checkStepName(id);
  if (looseSteps(text)[id]) throw new ConfigError(`There is already a step "${id}".`);
  const edits = tomlChanges(fields);
  const body: Record<string, TomlValue> = {};
  for (const key of STEP_KEYS) {
    const value = edits[key];
    if (value !== undefined) body[key] = value;
  }
  // A step is a table with a prompt; an empty one is written so it has a place to be typed.
  if (body.prompt === undefined) body.prompt = "";
  return addTable(text, table(id), body, {
    before: beforeStep === null ? null : table(beforeStep),
    last: LAST_KEYS,
  });
}

/** Takes a step out of the chain: what depended on it depends on what it depended on. */
function heal(text: string, id: string): string {
  const steps = looseSteps(text);
  const gone = requireStep(steps, id);
  let next = text;
  for (const [other, step] of Object.entries(steps)) {
    if (other === id || !step.depends_on.includes(id)) continue;
    const names = step.depends_on.flatMap((name) => (name === id ? gone.depends_on : [name]));
    next = setDepends(
      next,
      other,
      names.filter((name) => name !== other),
    );
  }
  return next;
}

/**
 * Removes a step. Steps that depended on it take over what it depended on, so the chain
 * stays in one piece. A prompt that used its result and a review of it are left as they are:
 * the check names them, and what to put there instead is the author's to decide.
 */
export function removeStep(text: string, id: string): string {
  return removeTable(heal(text, id), table(id));
}

/** Renames a step and follows the name through dependencies, reviews and prompts. */
export function renameStep(text: string, from: string, to: string): string {
  if (from === to) return text;
  checkStepName(to);
  const steps = looseSteps(text);
  requireStep(steps, from);
  if (steps[to]) throw new ConfigError(`There is already a step "${to}".`);
  let next = renameTable(text, table(from), table(to));
  const placeholder = new RegExp(`\\{\\{\\s*steps\\.${from}\\.result\\s*\\}\\}`, "g");
  for (const [id, step] of Object.entries(steps)) {
    const now = id === from ? to : id;
    if (step.depends_on.includes(from)) {
      next = setDepends(
        next,
        now,
        step.depends_on.map((name) => (name === from ? to : name)),
      );
    }
    if (step.reviews === from) next = setStepFields(next, now, { reviews: to });
    // The prompt keeps the form it is written in; only the name inside the braces changes.
    next = replaceInValue(next, table(now), "prompt", (raw) =>
      raw.replace(placeholder, `{{steps.${to}.result}}`),
    );
  }
  return next;
}

/** Moves a step in the file: before the step `before`, or with null to the end. */
export function moveStep(text: string, id: string, beforeStep: string | null): string {
  requireStep(looseSteps(text), id);
  return moveTable(text, table(id), beforeStep === null ? null : table(beforeStep));
}

export function setDescription(text: string, description: string | null): string {
  return setKeys(text, null, { description: description || undefined });
}

/** Makes `to` depend on `from`. Refused when that would make the steps go round in a loop. */
export function connect(text: string, from: string, to: string): string {
  const steps = looseSteps(text);
  requireStep(steps, from);
  const step = requireStep(steps, to);
  if (from === to) throw new ConfigError("A step cannot depend on itself.");
  if (before(steps, from).has(to)) {
    throw new ConfigError(`"${from}" already depends on "${to}"; the other way round is a loop.`);
  }
  if (step.depends_on.includes(from)) return text;
  return setDepends(text, to, [...step.depends_on, from]);
}

/** Takes away the dependency of `to` on `from`. */
export function disconnect(text: string, from: string, to: string): string {
  const step = requireStep(looseSteps(text), to);
  if (!step.depends_on.includes(from)) return text;
  return setDepends(
    text,
    to,
    step.depends_on.filter((name) => name !== from),
  );
}

/**
 * Makes `reviewer` a review of `target`: it may send that step back for another pass. A review
 * has to come after what it reviews, so the dependency is added when it is not there yet.
 */
export function makeReview(
  text: string,
  reviewer: string,
  target: string,
  rounds?: number,
): string {
  const steps = looseSteps(text);
  requireStep(steps, target);
  requireStep(steps, reviewer);
  if (reviewer === target) throw new ConfigError("A step cannot review itself.");
  let next = before(steps, reviewer).has(target) ? text : connect(text, target, reviewer);
  next = setStepFields(next, reviewer, {
    reviews: target,
    ...(rounds === undefined ? {} : { max_rounds: rounds }),
  });
  return next;
}

/** Makes a step an ordinary one again. */
export function clearReview(text: string, reviewer: string): string {
  return setStepFields(text, reviewer, { reviews: null, max_rounds: null });
}

/** The step written after `id` in the file, or null when it is the last. */
function following(text: string, id: string): string | null {
  const order = tableOrder(text, "steps");
  return order[order.indexOf(id) + 1] ?? null;
}

/** Lifts a step out of where it is, leaving the chain whole, ready to be put down elsewhere. */
function lift(text: string, id: string): string {
  return setDepends(heal(text, id), id, []);
}

/** Puts a step between two that follow each other: `from`, then the step, then `to`. */
export function insertOnEdge(text: string, id: string, from: string, to: string): string {
  if (id === from || id === to) return text;
  let next = lift(text, id);
  const target = requireStep(looseSteps(next), to);
  next = setDepends(next, id, [from]);
  next = setDepends(
    next,
    to,
    target.depends_on.map((name) => (name === from ? id : name)),
  );
  return moveStep(next, id, to);
}

/** Puts a step next to another: it depends on the same steps and runs side by side with it. */
export function placeBeside(text: string, id: string, sibling: string): string {
  if (id === sibling) return text;
  let next = lift(text, id);
  next = setDepends(next, id, requireStep(looseSteps(next), sibling).depends_on);
  const after = following(next, sibling);
  return after === id ? next : moveStep(next, id, after);
}

/** Puts a step under another: it depends on that step alone. */
export function placeBelow(text: string, id: string, parent: string): string {
  if (id === parent) return text;
  let next = lift(text, id);
  next = setDepends(next, id, [parent]);
  // After the steps that already follow the parent, so the file reads in the order it runs.
  const steps = looseSteps(next);
  const order = tableOrder(next, "steps");
  const children = order.filter(
    (other) => other !== id && steps[other]?.depends_on.includes(parent),
  );
  const after = following(next, children.at(-1) ?? parent);
  return after === id ? next : moveStep(next, id, after);
}

/** A step's keys as written for comparison: what the file leaves out is left out here too. */
function written(step: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of STEP_KEYS) {
    const value = step[key];
    if (value === undefined) continue;
    if (key === "depends_on" && Array.isArray(value) && value.length === 0) continue;
    if (key === "keep_agent" && value === false) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Changes a workflow text until it says what `target` says, touching only what differs. This
 * is how changes made to a run's own copy reach the file, which may look quite different and
 * has comments the run never had. `renames` (old name to new) keeps a renamed step's place
 * and comments; without it the step counts as removed and added.
 */
export function conform(
  text: string,
  target: WorkflowDefinition,
  renames: Record<string, string> = {},
): string {
  let next = text;
  for (const [from, to] of Object.entries(renames)) {
    const steps = looseSteps(next);
    if (steps[from] && !steps[to] && target.steps[to]) next = renameStep(next, from, to);
  }
  for (const id of Object.keys(looseSteps(next))) {
    if (!target.steps[id]) next = removeTable(next, table(id));
  }
  for (const [id, step] of Object.entries(target.steps)) {
    const current = looseSteps(next)[id];
    const wanted = written(step);
    if (!current) {
      next = addStep(next, id, wanted as StepFields);
      continue;
    }
    const has = written(current.fields);
    const changes: Record<string, unknown> = {};
    for (const key of STEP_KEYS) {
      if (JSON.stringify(has[key]) !== JSON.stringify(wanted[key]))
        changes[key] = wanted[key] ?? null;
    }
    if (Object.keys(changes).length > 0) next = setStepFields(next, id, changes as StepChanges);
  }
  const order = Object.keys(target.steps);
  for (let index = order.length - 1; index >= 0; index--) {
    if (tableOrder(next, "steps").join("\n") === order.join("\n")) break;
    next = moveStep(next, order[index] as string, order[index + 1] ?? null);
  }
  const description = (Bun.TOML.parse(next) as { description?: unknown }).description;
  if (description !== target.description) next = setDescription(next, target.description ?? null);
  return next;
}

/** What a new workflow file starts with: one step that passes the run's input on. */
export function workflowTemplate(description: string): string {
  const head = description ? `description = ${JSON.stringify(description)}\n\n` : "";
  return `${head}[steps.work]\nprompt = """\n{{input}}\n"""\n`;
}

/** The workflow's file, hidden or not. Throws when there is none. */
export function requireWorkflow(ref: WorkflowRef, ctx: ScopeContext): ItemEntry {
  return requireItem(workflowKind, ref, ctx);
}

/** The history of a workflow's file. */
export function workflowHistory(ref: WorkflowRef, ctx: ScopeContext): Tracked {
  return trackedEntry(workflowKind, requireWorkflow(ref, ctx), ctx);
}

/**
 * Writes a workflow file. The text has to be a valid workflow, otherwise nothing is written.
 * Returns the version the file is at afterwards.
 */
export function saveWorkflowText(
  ref: WorkflowRef,
  text: string,
  source: string,
  ctx: ScopeContext,
  now: Date = new Date(),
): Version {
  const entry = requireWorkflow(ref, ctx);
  parseWorkflow(text, entry.name, entry.path);
  return saveTracked(trackedEntry(workflowKind, entry, ctx), text, source, now);
}

function newWorkflowPath(name: string, ctx: ScopeContext, personal: boolean): string {
  if (!validWorkflowName(name)) {
    throw new ConfigError(
      `"${name}" cannot be a workflow name: use letters, digits, - and _ (up to 40).`,
    );
  }
  // In either place: a second file of a name would hide one of the two.
  const taken = listAllWorkflows(ctx).find((workflow) => workflow.name === name);
  if (taken) {
    throw new ConfigError(
      taken.source === "user"
        ? `There is already a personal workflow "${name}".`
        : `There is already a workflow "${name}".`,
    );
  }
  return join(workflowKind.dir(personal ? "user" : "project", ctx), `${name}.toml`);
}

/** Creates a workflow file from a valid workflow text. */
export function createWorkflow(
  name: string,
  text: string,
  source: string,
  ctx: ScopeContext,
  options: { personal?: boolean; now?: Date } = {},
): ItemEntry {
  const path = newWorkflowPath(name, ctx, options.personal ?? false);
  parseWorkflow(text, name, path);
  const entry: ItemEntry = {
    name,
    source: options.personal ? "user" : "project",
    path,
    hidden: false,
  };
  saveTracked(trackedEntry(workflowKind, entry, ctx), text, source, options.now);
  return entry;
}

/** A new workflow with the same file content: next to the original, or where `personal` says. */
export function duplicateWorkflow(
  from: WorkflowRef,
  to: string,
  ctx: ScopeContext,
  options: { personal?: boolean } = {},
): ItemEntry {
  const origin = requireWorkflow(from, ctx);
  return createWorkflow(to, readFileSync(origin.path, "utf8"), `copy of ${origin.name}`, ctx, {
    personal: options.personal ?? origin.source === "user",
  });
}

/** Renames a workflow file; its history moves with it. Runs already started keep their name. */
export function renameWorkflow(ref: WorkflowRef, to: string, ctx: ScopeContext): ItemEntry {
  const entry = requireWorkflow(ref, ctx);
  const path = newWorkflowPath(to, ctx, entry.source === "user");
  const renamed: ItemEntry = { name: to, source: entry.source, path, hidden: false };
  const oldHistory = trackedEntry(workflowKind, entry, ctx);
  record(oldHistory, BY_HAND);
  mkdirSync(dirname(path), { recursive: true });
  renameSync(entry.path, path);
  moveHistory(oldHistory, trackedEntry(workflowKind, renamed, ctx));
  return renamed;
}

/** Moves a workflow between the project and the personal folder, with its history. */
export function moveWorkflow(ref: WorkflowRef, to: Scope, ctx: ScopeContext): ItemEntry {
  return moveItem(workflowKind, requireWorkflow(ref, ctx), to, ctx);
}

/** Deletes a workflow file. Its history stays. */
export function deleteWorkflow(ref: WorkflowRef, ctx: ScopeContext): void {
  const entry = requireWorkflow(ref, ctx);
  record(trackedEntry(workflowKind, entry, ctx), BY_HAND);
  rmSync(entry.path);
}

/** Gives the file the content of a version. One that is no longer a valid workflow is refused. */
export function switchWorkflow(ref: WorkflowRef, n: number, ctx: ScopeContext): Version {
  const entry = requireWorkflow(ref, ctx);
  const tracked = trackedEntry(workflowKind, entry, ctx);
  parseWorkflow(versionText(tracked, n), entry.name, `v${n}`);
  return switchTo(tracked, n);
}

/**
 * What a change means beyond this project's files: other projects that share a personal
 * workflow, a personal one that comes out from behind the project's.
 */
export function workflowWarnings(
  action: "rename" | "delete" | "move",
  ref: WorkflowRef,
  ctx: ScopeContext,
): string[] {
  const entry = requireWorkflow(ref, ctx);
  const { name } = entry;
  if (entry.source === "user") {
    const roles = action === "move" ? " Its steps name roles; the project needs them too." : "";
    return [
      `Other projects that use your personal workflow "${name}" are not checked.${roles}`.trim(),
    ];
  }
  if (action === "move") {
    return [`Others who use this project will no longer have workflow "${name}".`];
  }
  const twin = listAllWorkflows(ctx).some((other) => other.name === name && other.hidden);
  return twin
    ? [
        `Your personal workflow "${name}" is hidden by this one and will be the one used here afterwards.`,
      ]
    : [];
}

/**
 * Brings the history up to date with what is on disk, so a workflow changed in an editor gets
 * its version. Called wherever dwa reads these files on the user's behalf.
 */
export function noticeWorkflowEdits(ctx: ScopeContext): void {
  try {
    for (const entry of listAllWorkflows(ctx))
      record(trackedEntry(workflowKind, entry, ctx), BY_HAND);
  } catch {
    // History is a convenience; a folder that cannot be written must not stop a run.
  }
}

/** The steps of the workflows used here that run as a role. */
export function roleMentions(
  role: string,
  ctx: ScopeContext,
): { workflow: string; step: string; personal: boolean }[] {
  const found: { workflow: string; step: string; personal: boolean }[] = [];
  for (const entry of listAllWorkflows(ctx)) {
    if (entry.hidden || !existsSync(entry.path)) continue;
    try {
      mapValues(readFileSync(entry.path, "utf8"), (inTable, key, value) => {
        if (key === "role" && value === role && inTable?.startsWith("steps.")) {
          found.push({
            workflow: entry.name,
            step: inTable.slice("steps.".length),
            personal: entry.source === "user",
          });
        }
        return undefined;
      });
    } catch {
      // A file that cannot be read as TOML is reported by `config check`, not here.
    }
  }
  return found;
}

/** Follows a renamed role through the workflows used here; each changed file gets a version. */
export function followRoleRename(from: string, to: string, ctx: ScopeContext): void {
  const files = new Set(roleMentions(from, ctx).map((mention) => mention.workflow));
  for (const entry of listAllWorkflows(ctx)) {
    if (entry.hidden || !files.has(entry.name)) continue;
    const text = mapValues(readFileSync(entry.path, "utf8"), (inTable, key, value) =>
      key === "role" && value === from && inTable?.startsWith("steps.") ? to : undefined,
    );
    saveTracked(trackedEntry(workflowKind, entry, ctx), text, `role ${from} renamed to ${to}`);
  }
}
