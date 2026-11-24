import { APP_NAME } from "../shared/constants.ts";
import type { WorkflowRunInfo } from "../shared/protocol.ts";
import { describeRun, type WorkflowSummary } from "../shared/workflow.ts";
import { call } from "./client.ts";

interface Listing {
  workflows: WorkflowSummary[];
  runs: WorkflowRunInfo[];
}

function runId(value: string | undefined): number {
  const id = Number(value?.replace(/^#/, ""));
  if (!Number.isInteger(id) || id <= 0) throw new Error("Give the number of a workflow run.");
  return id;
}

/** `dwa workflow list | run | status | cancel`. */
export async function workflowCommand(projectRoot: string, args: string[]): Promise<number> {
  const [action, target, ...words] = args;
  switch (action) {
    case "list":
    case undefined: {
      const { workflows, runs } = await call<Listing>(projectRoot, "GET", "/workflows");
      if (workflows.length === 0) {
        console.log(`No workflows defined. Add one as .${APP_NAME}/workflows/<name>.toml.`);
      }
      for (const workflow of workflows) {
        console.log(
          workflow.error
            ? `${workflow.name}\tinvalid: ${workflow.error}`
            : `${workflow.name}\t${workflow.description ?? workflow.steps.join(" -> ")}`,
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
    default:
      console.error(`Unknown workflow command: ${action}`);
      return 2;
  }
}
