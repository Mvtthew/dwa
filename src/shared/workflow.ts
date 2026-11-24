import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ConfigError, EffortSchema, ModelSchema } from "./config.ts";
import { workflowsDir } from "./paths.ts";
import type { WorkflowRunInfo, WorkflowStepState } from "./protocol.ts";

/** Step ids become agent names and workflow names become file names, so both stay simple. */
const NAME = /^[A-Za-z0-9][\w-]{0,39}$/;

const StepSchema = z.strictObject({
  /** First prompt of the step's session. May use `{{input}}` and `{{steps.<id>.result}}`. */
  prompt: z.string().min(1),
  /** Agent definition to run as (a `.claude/agents/<role>.md` file). */
  role: z.string().optional(),
  profile: z.string().optional(),
  /** Model and effort for the step's session; without them the role file or the defaults apply. */
  model: ModelSchema.optional(),
  effort: EffortSchema.optional(),
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
});

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

export function parseWorkflow(text: string, name: string, source = name): WorkflowDefinition {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (error) {
    throw new ConfigError(`${source}: invalid TOML: ${(error as Error).message}`);
  }
  const result = WorkflowSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`${source}: ${issues}`);
  }
  const { steps, description } = result.data;
  const ids = Object.keys(steps);
  if (ids.length === 0) throw new ConfigError(`${source}: a workflow needs at least one step`);

  for (const [id, step] of Object.entries(steps)) {
    if (!NAME.test(id)) {
      throw new ConfigError(
        `${source}: step name "${id}" may only use letters, digits, - and _ (up to 40)`,
      );
    }
    for (const dependency of step.depends_on) {
      if (!(dependency in steps)) {
        throw new ConfigError(`${source}: step "${id}" depends on unknown step "${dependency}"`);
      }
    }
  }

  const before = ancestors(steps, source);
  for (const [id, step] of Object.entries(steps)) {
    for (const [, expression = ""] of step.prompt.matchAll(PLACEHOLDER)) {
      if (expression === "input") continue;
      const other = STEP_RESULT.exec(expression)?.[1];
      if (!other) {
        throw new ConfigError(
          `${source}: step "${id}" uses unknown placeholder {{${expression}}}; use {{input}} or {{steps.<name>.result}}`,
        );
      }
      if (!before.get(id)?.has(other)) {
        throw new ConfigError(
          `${source}: step "${id}" uses the result of "${other}" but does not depend on it`,
        );
      }
    }
  }

  for (const [id, step] of Object.entries(steps)) {
    const target = step.reviews;
    if (target === undefined) {
      if (step.max_rounds !== undefined) {
        throw new ConfigError(`${source}: step "${id}" sets max_rounds but reviews nothing`);
      }
      continue;
    }
    if (!(target in steps)) {
      throw new ConfigError(`${source}: step "${id}" reviews unknown step "${target}"`);
    }
    if (!before.get(id)?.has(target)) {
      throw new ConfigError(
        `${source}: step "${id}" reviews "${target}" but does not depend on it`,
      );
    }
    // Work that can be sent back must not be used by a step the review does not gate.
    for (const other of ids) {
      if (other === id || !before.get(other)?.has(target)) continue;
      if (before.get(id)?.has(other) || before.get(other)?.has(id)) continue;
      throw new ConfigError(
        `${source}: step "${other}" depends on "${target}", which "${id}" reviews; make "${other}" depend on "${id}", or "${id}" on "${other}"`,
      );
    }
  }
  return { name, description, steps };
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

function workflowPath(projectRoot: string, name: string): string {
  return join(workflowsDir(projectRoot), `${name}.toml`);
}

/** Reads and validates `.dwa/workflows/<name>.toml`. */
export function loadWorkflow(projectRoot: string, name: string): WorkflowDefinition {
  const names = () =>
    listWorkflows(projectRoot)
      .map((workflow) => workflow.name)
      .join(", ") || "none defined";
  if (!NAME.test(name)) throw new ConfigError(`Unknown workflow "${name}" (available: ${names()})`);
  const path = workflowPath(projectRoot, name);
  if (!existsSync(path)) {
    throw new ConfigError(`Unknown workflow "${name}" (available: ${names()})`);
  }
  return parseWorkflow(readFileSync(path, "utf8"), name, path);
}

/** Every workflow file of the project, by name. A broken file is listed with its error. */
export function listWorkflows(projectRoot: string): WorkflowSummary[] {
  const dir = workflowsDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".toml") && NAME.test(file.slice(0, -5)))
    .sort()
    .map((file) => {
      const name = file.slice(0, -5);
      try {
        const workflow = parseWorkflow(readFileSync(join(dir, file), "utf8"), name, file);
        return {
          name,
          description: workflow.description ?? null,
          steps: Object.keys(workflow.steps),
          error: null,
        };
      } catch (error) {
        return { name, description: null, steps: [], error: (error as Error).message };
      }
    });
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
