import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  CAPABILITY_KEYS,
  ConfigError,
  capabilityFields,
  pickCapabilities,
  refuseBothToolLists,
} from "./capabilities.ts";
import { userWorkflowsDir, workflowsDir } from "./paths.ts";
import type { WorkflowRunInfo, WorkflowStepState } from "./protocol.ts";
import { type ItemEntry, type ItemKind, listItems, type ScopeContext, winner } from "./scope.ts";
import { tomlString } from "./toml.ts";

type Env = Record<string, string | undefined>;

/** Step ids become agent names and workflow names become file names, so both stay simple. */
const NAME = /^[A-Za-z0-9][\w-]{0,39}$/;

const StepSchema = z
  .strictObject({
    /** First prompt of the step's session. May use `{{input}}` and `{{steps.<id>.result}}`. */
    prompt: z.string().min(1),
    /** Role to run as (a `.dwa/roles/<role>.toml` file). */
    role: z.string().optional(),
    profile: z.string().optional(),
    /**
     * Model, effort, tools, MCP servers, plugins and skills for the step's session. Anything set
     * here replaces what the role says; without it the role and the defaults apply.
     */
    ...capabilityFields,
    /** Steps that must be done before this one starts. */
    depends_on: z.array(z.string()).default([]),
    /** Leave the step's session running after it completes. */
    keep_agent: z.boolean().default(false),
    /**
     * Makes this a review of an earlier step: its agent may send that step back for another pass
     * with `request_changes` instead of completing.
     */
    reviews: z.string().optional(),
    /** Review passes before the user is asked what to do. Only with `reviews`. */
    max_rounds: z.number().int().min(1).optional(),
  })
  .superRefine(refuseBothToolLists);

/** Review passes a review step gets when it does not set `max_rounds`. */
export const DEFAULT_MAX_ROUNDS = 3;

const WorkflowSchema = z.strictObject({
  description: z.string().optional(),
  steps: z.record(z.string(), StepSchema),
});

export type WorkflowStep = z.infer<typeof StepSchema>;

export interface WorkflowDefinition {
  name: string;
  description?: string;
  /** In the order they appear in the file. */
  steps: Record<string, WorkflowStep>;
}

/** A workflow file as listed for the user; `error` is set when it does not validate. */
export interface WorkflowSummary {
  name: string;
  /** Kept in the personal folder, not in the project. */
  personal: boolean;
  description: string | null;
  steps: string[];
  error: string | null;
}

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const STEP_RESULT = /^steps\.([\w-]+)\.result$/;

/** Every step a step depends on, directly or through other steps. Throws on a cycle. */
function ancestors(steps: Record<string, WorkflowStep>, source: string): Map<string, Set<string>> {
  const done = new Map<string, Set<string>>();
  const visiting: string[] = [];
  const visit = (id: string): Set<string> => {
    const known = done.get(id);
    if (known) return known;
    if (visiting.includes(id)) {
      const cycle = [...visiting.slice(visiting.indexOf(id)), id].join(" -> ");
      throw new ConfigError(`${source}: steps depend on each other in a cycle (${cycle})`);
    }
    visiting.push(id);
    const all = new Set<string>();
    for (const dependency of steps[id]?.depends_on ?? []) {
      all.add(dependency);
      for (const further of visit(dependency)) all.add(further);
    }
    visiting.pop();
    done.set(id, all);
    return all;
  };
  for (const id of Object.keys(steps)) visit(id);
  return done;
}

/** For every step, the steps it depends on directly or through others. Throws on a cycle. */
export function ancestorsOf(definition: WorkflowDefinition): Map<string, Set<string>> {
  return ancestors(definition.steps, definition.name);
}

/** One thing wrong with a workflow text, with the step and key it is about when it has them. */
export interface WorkflowProblem {
  message: string;
  step?: string;
  key?: string;
}

/** A workflow text that does not validate; `problems` has everything found, not only the first. */
export class WorkflowError extends ConfigError {
  constructor(
    message: string,
    readonly problems: WorkflowProblem[],
  ) {
    super(message);
  }
}

export interface WorkflowCheck {
  /** The definition when nothing is wrong, otherwise null. */
  definition: WorkflowDefinition | null;
  /** In the order they are found; `parseWorkflow` reports the first. */
  problems: WorkflowProblem[];
  /** True when the text is not TOML or not shaped like a workflow at all, so the later checks did not run. */
  shape: boolean;
}

/**
 * Everything wrong with a workflow text. An editor shows all of it at the steps concerned;
 * `parseWorkflow` is the same check that stops at the first problem.
 */
export function checkWorkflow(text: string, name: string): WorkflowCheck {
  const problems: WorkflowProblem[] = [];
  const failed = (shape = false): WorkflowCheck => ({ definition: null, problems, shape });
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (error) {
    problems.push({ message: `invalid TOML: ${(error as Error).message}` });
    return failed(true);
  }
  const result = WorkflowSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const [first, step, key] = issue.path;
      problems.push({
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        ...(first === "steps" && typeof step === "string" ? { step } : {}),
        ...(first === "steps" && typeof key === "string" ? { key } : {}),
      });
    }
    return failed(true);
  }
  const { steps, description } = result.data;
  const ids = Object.keys(steps);
  if (ids.length === 0) {
    problems.push({ message: "a workflow needs at least one step" });
    return failed();
  }

  for (const [id, step] of Object.entries(steps)) {
    if (!NAME.test(id)) {
      problems.push({
        message: `step name "${id}" may only use letters, digits, - and _ (up to 40)`,
        step: id,
      });
      continue;
    }
    for (const dependency of step.depends_on) {
      if (!(dependency in steps)) {
        problems.push({
          message: `step "${id}" depends on unknown step "${dependency}"`,
          step: id,
          key: "depends_on",
        });
      }
    }
  }

  let before: Map<string, Set<string>>;
  try {
    before = ancestors(steps, "");
  } catch (error) {
    // Everything below asks what comes before what, which a cycle has no answer to.
    problems.push({ message: (error as Error).message.slice(": ".length) });
    return failed();
  }
  for (const [id, step] of Object.entries(steps)) {
    for (const [, expression = ""] of step.prompt.matchAll(PLACEHOLDER)) {
      if (expression === "input") continue;
      const other = STEP_RESULT.exec(expression)?.[1];
      const message = !other
        ? `step "${id}" uses unknown placeholder {{${expression}}}; use {{input}} or {{steps.<name>.result}}`
        : !before.get(id)?.has(other)
          ? `step "${id}" uses the result of "${other}" but does not depend on it`
          : null;
      if (message) problems.push({ message, step: id, key: "prompt" });
    }
  }

  for (const [id, step] of Object.entries(steps)) {
    const target = step.reviews;
    if (target === undefined) {
      if (step.max_rounds !== undefined) {
        problems.push({
          message: `step "${id}" sets max_rounds but reviews nothing`,
          step: id,
          key: "max_rounds",
        });
      }
      continue;
    }
    if (!(target in steps)) {
      problems.push({
        message: `step "${id}" reviews unknown step "${target}"`,
        step: id,
        key: "reviews",
      });
      continue;
    }
    if (!before.get(id)?.has(target)) {
      problems.push({
        message: `step "${id}" reviews "${target}" but does not depend on it`,
        step: id,
        key: "reviews",
      });
      continue;
    }
    // Work that can be sent back must not be used by a step the review does not gate.
    for (const other of ids) {
      if (other === id || !before.get(other)?.has(target)) continue;
      if (before.get(id)?.has(other) || before.get(other)?.has(id)) continue;
      problems.push({
        message: `step "${other}" depends on "${target}", which "${id}" reviews; make "${other}" depend on "${id}", or "${id}" on "${other}"`,
        step: other,
        key: "depends_on",
      });
    }
  }
  if (problems.length > 0) return failed();
  return { definition: { name, description, steps }, problems, shape: false };
}

export function parseWorkflow(text: string, name: string, source = name): WorkflowDefinition {
  const { definition, problems, shape } = checkWorkflow(text, name);
  if (definition) return definition;
  // A text of the wrong shape is reported whole; anything else by the first thing wrong.
  const message = shape
    ? problems.map((problem) => problem.message).join("; ")
    : (problems[0]?.message ?? "");
  throw new WorkflowError(`${source}: ${message}`, problems);
}

/**
 * The steps redone when a review step sends its work back, in file order: the reviewed step,
 * every step between it and the review, and the review itself.
 */
export function reworkSteps(definition: WorkflowDefinition, reviewer: string): string[] {
  const target = definition.steps[reviewer]?.reviews;
  if (!target) return [];
  const before = ancestors(definition.steps, definition.name);
  return Object.keys(definition.steps).filter(
    (id) =>
      id === target ||
      id === reviewer ||
      (before.get(id)?.has(target) && before.get(reviewer)?.has(id)),
  );
}

/** Steps that depend, directly or through other steps, on any of `ids`. In file order. */
export function dependents(definition: WorkflowDefinition, ids: string[]): string[] {
  const before = ancestors(definition.steps, definition.name);
  return Object.keys(definition.steps).filter((id) =>
    ids.some((other) => before.get(id)?.has(other)),
  );
}

/** True when two versions of a step ask for the same work, so a finished one need not run again. */
export function sameWork(a: WorkflowStep, b: WorkflowStep): boolean {
  const key = (step: WorkflowStep) =>
    JSON.stringify([
      step.prompt,
      step.role,
      step.profile,
      CAPABILITY_KEYS.map((field) => step[field] ?? null),
      step.reviews,
      [...step.depends_on].sort(),
    ]);
  return key(a) === key(b);
}

/**
 * A definition as TOML, the form a run's own copy is edited in. `header` lines become comments
 * at the top. Parsing the text again gives the same definition.
 */
export function formatWorkflow(definition: WorkflowDefinition, header: string[] = []): string {
  const lines = header.map((line) => (line ? `# ${line}` : "#"));
  if (header.length > 0) lines.push("");
  if (definition.description !== undefined) {
    lines.push(`description = ${tomlString(definition.description)}`, "");
  }
  for (const [id, step] of Object.entries(definition.steps)) {
    lines.push(`[steps.${id}]`);
    if (step.role !== undefined) lines.push(`role = ${tomlString(step.role)}`);
    if (step.profile !== undefined) lines.push(`profile = ${tomlString(step.profile)}`);
    for (const [field, value] of Object.entries(pickCapabilities(step))) {
      const text = Array.isArray(value)
        ? `[${value.map(tomlString).join(", ")}]`
        : typeof value === "boolean"
          ? String(value)
          : tomlString(value);
      lines.push(`${field} = ${text}`);
    }
    if (step.depends_on.length > 0) {
      lines.push(`depends_on = [${step.depends_on.map(tomlString).join(", ")}]`);
    }
    if (step.reviews !== undefined) lines.push(`reviews = ${tomlString(step.reviews)}`);
    if (step.max_rounds !== undefined) lines.push(`max_rounds = ${step.max_rounds}`);
    if (step.keep_agent) lines.push("keep_agent = true");
    lines.push(`prompt = ${tomlString(step.prompt)}`, "");
  }
  return lines.join("\n");
}

/** Workflow files as a kind of file kept in the project and in the personal folder. */
export const workflowKind: ItemKind = {
  id: "workflows",
  label: "workflow",
  dir: (source, ctx) =>
    source === "user" ? userWorkflowsDir(ctx.env) : workflowsDir(ctx.projectRoot),
  valid: (name) => NAME.test(name),
};

/** True for a name a workflow file or a step may have. */
export function validWorkflowName(name: string): boolean {
  return NAME.test(name);
}

/**
 * Every workflow file in both places, for the editors. A personal one the project has a
 * workflow of the same name for is `hidden`: a run of that name uses the project's.
 */
export function listAllWorkflows(ctx: ScopeContext): ItemEntry[] {
  return listItems(workflowKind, ctx);
}

/** The file a run of this name uses: the project's, otherwise the personal one. */
export function findWorkflow(name: string, ctx: ScopeContext): ItemEntry | null {
  return NAME.test(name) ? winner(workflowKind, name, ctx) : null;
}

/** Reads and validates the workflow a run of this name uses. */
export function loadWorkflow(projectRoot: string, name: string, env?: Env): WorkflowDefinition {
  const entry = findWorkflow(name, { projectRoot, env });
  if (!entry) {
    const names =
      listWorkflows(projectRoot, env)
        .map((workflow) => workflow.name)
        .join(", ") || "none defined";
    throw new ConfigError(`Unknown workflow "${name}" (available: ${names})`);
  }
  return parseWorkflow(readFileSync(entry.path, "utf8"), name, entry.path);
}

/** One workflow file as it is listed. A broken file is listed with its error. */
export function summarizeWorkflow(entry: ItemEntry): WorkflowSummary {
  const { name } = entry;
  const personal = entry.source === "user";
  try {
    const file = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const workflow = parseWorkflow(readFileSync(entry.path, "utf8"), name, file);
    return {
      name,
      personal,
      description: workflow.description ?? null,
      steps: Object.keys(workflow.steps),
      error: null,
    };
  } catch (error) {
    return { name, personal, description: null, steps: [], error: (error as Error).message };
  }
}

/** Every workflow a run can be started from here, by name: the project's and the personal ones it does not hide. */
export function listWorkflows(projectRoot: string, env?: Env): WorkflowSummary[] {
  return listAllWorkflows({ projectRoot, env })
    .filter((entry) => !entry.hidden)
    .map(summarizeWorkflow);
}

/** Fills a step's prompt with the run's input and the results of earlier steps. */
export function renderPrompt(
  prompt: string,
  input: string,
  results: Record<string, string | null | undefined>,
): string {
  return prompt.replace(PLACEHOLDER, (whole, expression: string) => {
    if (expression === "input") return input;
    const other = STEP_RESULT.exec(expression)?.[1];
    return other ? (results[other] ?? "") : whole;
  });
}

/** Pending steps whose dependencies are all done, in file order. */
export function readySteps(
  definition: WorkflowDefinition,
  states: Record<string, WorkflowStepState | undefined>,
): string[] {
  return Object.entries(definition.steps)
    .filter(
      ([id, step]) =>
        states[id] === "pending" &&
        step.depends_on.every((dependency) => states[dependency] === "done"),
    )
    .map(([id]) => id);
}

/** A run as text, for the CLI and for agents. With `results`, each finished step's result follows. */
export function describeRun(run: WorkflowRunInfo, results = false): string {
  const lines = [`Run #${run.id} of "${run.name}": ${run.state} (started by ${run.startedBy})`];
  for (const step of run.steps) {
    const notes: string[] = [];
    if (step.agent && step.state === "running") notes.push(`agent "${step.agent}"`);
    if (step.attempt > 1) notes.push(`pass ${step.attempt}`);
    if (step.state === "rejected") notes.push("changes requested, waiting for your decision");
    else if (step.needsAttention) notes.push("needs attention");
    if (step.state === "pending" && step.dependsOn.length > 0) {
      notes.push(`after ${step.dependsOn.join(", ")}`);
    }
    if (step.error) notes.push(step.error);
    lines.push(`  ${step.id}: ${step.state}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`);
    if (results && step.result && step.state !== "rejected") {
      for (const line of step.result.split("\n")) lines.push(`      ${line}`);
    }
  }
  return lines.join("\n");
}
