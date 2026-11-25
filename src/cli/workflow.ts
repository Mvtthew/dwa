import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME } from "../shared/constants.ts";
import { runDir } from "../shared/paths.ts";
import type { WorkflowEdit, WorkflowRunInfo } from "../shared/protocol.ts";
import { describeRun, type WorkflowSummary } from "../shared/workflow.ts";
import { call } from "./client.ts";
import { openEditor } from "./editor.ts";
import { WORKFLOW_FILE_ACTIONS, workflowFileCommand } from "./workflow-files.ts";

interface Listing {
  workflows: WorkflowSummary[];
  runs: WorkflowRunInfo[];
}

function runId(value: string | undefined): number {
  const id = Number(value?.replace(/^#/, ""));
  if (!Number.isInteger(id) || id <= 0) throw new Error("Give the number of a workflow run.");
  return id;
}

/**
 * Shows what an edit would do, asks before work already done is thrown away, then applies it.
 * Throws when the definition does not validate.
 */
async function applyEdit(
  projectRoot: string,
  id: number,
  definition: string,
  yes: boolean,
): Promise<number> {
  const send = (preview: boolean) =>
    call<WorkflowEdit>(projectRoot, "POST", "/workflows/edit", { id, definition, preview });
  const preview = await send(true);
  if (preview.changes.length === 0) {
    console.log("No changes.");
    return 0;
  }
  for (const change of preview.changes) console.log(`  ${change}`);
  if (preview.restarts && !yes) {
    if (!process.stdin.isTTY) {
      console.error("This throws away work already done. Pass --yes to apply it.");
      return 1;
    }
    const reply = prompt("This throws away work already done. Apply? [y/N]");
    if (!reply?.trim().toLowerCase().startsWith("y")) {
      console.log("Not applied.");
      return 1;
    }
  }
  console.log(describeRun((await send(false)).run));
  return 0;
}

/** Opens the run's own definition in the user's editor, again after a mistake, until it applies. */
async function editInEditor(projectRoot: string, id: number, yes: boolean): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error(`Without a terminal, give a file: ${APP_NAME} workflow edit <run> <file>`);
    return 2;
  }
  const { definition } = await call<{ definition: string }>(
    projectRoot,
    "POST",
    "/workflows/definition",
    { id },
  );
  mkdirSync(runDir(projectRoot), { recursive: true });
  const path = join(runDir(projectRoot), `workflow-run-${id}.toml`);
  writeFileSync(path, definition);
  for (;;) {
    if (!(await openEditor(path))) {
      console.error("The editor did not exit cleanly; nothing was applied.");
      return 1;
    }
    const text = readFileSync(path, "utf8");
    if (text === definition) {
      console.log("No changes.");
      return 0;
    }
    try {
      return await applyEdit(projectRoot, id, text, yes);
    } catch (error) {
      console.error((error as Error).message);
      if (prompt("Press Enter to edit again, or type q to give up.")?.trim() === "q") return 1;
    }
  }
}

/** `dwa workflow list | run | status | cancel | complete | fail | definition | edit`. */
export async function workflowCommand(projectRoot: string, args: string[]): Promise<number> {
  const [action, target, ...words] = args;
  if (action && WORKFLOW_FILE_ACTIONS.includes(action)) {
    return workflowFileCommand(projectRoot, action, args.slice(1));
  }
  switch (action) {
    case "list":
    case undefined: {
      const { workflows, runs } = await call<Listing>(projectRoot, "GET", "/workflows");
      if (workflows.length === 0) {
        console.log(`No workflows defined. Add one with: ${APP_NAME} workflow new <name>`);
      }
      for (const workflow of workflows) {
        console.log(
          workflow.error
            ? `${workflow.name}\tinvalid: ${workflow.error}`
            : `${workflow.name}\t${workflow.description ?? workflow.steps.join(" -> ")}${workflow.personal ? "  (personal)" : ""}`,
        );
      }
      for (const run of runs) console.log(`\n${describeRun(run)}`);
      return 0;
    }
    case "run": {
      if (!target) {
        console.error(`Usage: ${APP_NAME} workflow run <name> [input]`);
        return 2;
      }
      const run = await call<WorkflowRunInfo>(projectRoot, "POST", "/workflows/run", {
        name: target,
        input: words.join(" "),
      });
      console.log(describeRun(run));
      return 0;
    }
    case "status": {
      if (target) {
        const run = await call<WorkflowRunInfo>(projectRoot, "POST", "/workflows/status", {
          id: runId(target),
        });
        console.log(describeRun(run, true));
        return 0;
      }
      const { runs } = await call<Listing>(projectRoot, "GET", "/workflows");
      const [latest] = runs;
      console.log(latest ? describeRun(latest, true) : "No workflow runs yet.");
      return 0;
    }
    case "cancel": {
      const run = await call<WorkflowRunInfo>(projectRoot, "POST", "/workflows/cancel", {
        id: runId(target),
      });
      console.log(describeRun(run));
      return 0;
    }
    case "definition": {
      const { definition } = await call<{ definition: string }>(
        projectRoot,
        "POST",
        "/workflows/definition",
        { id: runId(target) },
      );
      console.log(definition);
      return 0;
    }
    case "edit": {
      const yes = words.includes("--yes");
      const file = words.find((word) => !word.startsWith("--"));
      const id = runId(target);
      if (!file) return editInEditor(projectRoot, id, yes);
      return applyEdit(projectRoot, id, readFileSync(file, "utf8"), yes);
    }
    case "complete":
    case "fail": {
      const [step, ...rest] = words;
      const text = rest.join(" ");
      if (!target || !step || !text) {
        console.error(
          `Usage: ${APP_NAME} workflow ${action} <run> <step> <${action === "complete" ? "result" : "reason"}>`,
        );
        return 2;
      }
      const run = await call<WorkflowRunInfo>(projectRoot, "POST", `/workflows/step/${action}`, {
        id: runId(target),
        step,
        ...(action === "complete" ? { result: text } : { reason: text }),
      });
      console.log(describeRun(run));
      return 0;
    }
    default:
      console.error(`Unknown workflow command: ${action}`);
      return 2;
  }
}
