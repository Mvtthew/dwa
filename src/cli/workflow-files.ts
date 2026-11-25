// The `dwa workflow` commands that work on the workflow files themselves: creating, copying,
// renaming, moving and deleting them, their history, and the picture of one. They read and
// write files only; the workspace does not have to be running.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { APP_NAME } from "../shared/constants.ts";
import { diagramText, fromDefinition, layoutDiagram } from "../shared/diagram.ts";
import { parseRef, type Scope, type ScopeContext, scopeLabel } from "../shared/scope.ts";
import { parseWorkflow } from "../shared/workflow.ts";
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  moveWorkflow,
  noticeWorkflowEdits,
  renameWorkflow,
  requireWorkflow,
  switchWorkflow,
  workflowHistory,
  workflowTemplate,
  workflowWarnings,
} from "../shared/workflow-edit.ts";
import { printDiff, printHistory, versionNumber } from "./versions.ts";

export const WORKFLOW_FILE_ACTIONS = [
  "new",
  "duplicate",
  "rename",
  "move",
  "delete",
  "history",
  "diff",
  "switch",
  "show",
];

const USAGE = `Usage:
  ${APP_NAME} workflow new <name> [--description <text>] [--personal]
  ${APP_NAME} workflow duplicate <workflow> <new name> [--to personal|project]
  ${APP_NAME} workflow rename <workflow> <new name>
  ${APP_NAME} workflow move <workflow> --to personal|project   With its history; the name stays
  ${APP_NAME} workflow delete <workflow>            Its history is kept
  ${APP_NAME} workflow show <workflow>              The steps as a picture
  ${APP_NAME} workflow history <workflow> [--json]  Versions of the file
  ${APP_NAME} workflow diff <workflow> [vA] [vB]    What changed (the current version against the one before)
  ${APP_NAME} workflow switch <workflow> <vN>       Give the file the content of that version

A workflow name means the one a run uses: the project's before a personal one of the same
name. --personal or --project (or personal:<name>, project:<name>) names one file exactly.`;

function placeOf(text: string | undefined): Scope | undefined {
  return text === "personal" ? "user" : text === "project" ? "project" : undefined;
}

function printWarnings(lines: string[]): void {
  for (const line of lines) console.log(`Note: ${line}`);
}

/** Runs one of `WORKFLOW_FILE_ACTIONS`. */
export function workflowFileCommand(projectRoot: string, action: string, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      personal: { type: "boolean" },
      project: { type: "boolean" },
      to: { type: "string" },
      description: { type: "string" },
    },
  });
  const [word, second, third] = positionals;
  const ctx: ScopeContext = { projectRoot };
  // Whatever was changed in an editor since the last look gets its version first.
  noticeWorkflowEdits(ctx);
  const usage = () => {
    console.error(USAGE);
    return 2;
  };
  if (!word) return usage();
  try {
    if (action === "new") {
      const text = workflowTemplate(values.description ?? "");
      const entry = createWorkflow(word, text, "workflow new", ctx, { personal: values.personal });
      console.log(`Created ${entry.path}`);
      return 0;
    }
    const named = parseRef(word);
    const workflow = requireWorkflow(
      {
        name: named.name,
        source: values.personal ? "user" : values.project ? "project" : named.source,
      },
      ctx,
    );
    const { name } = workflow;
    switch (action) {
      case "duplicate": {
        const to = placeOf(values.to);
        if (!second || (values.to !== undefined && !to)) return usage();
        const copy = duplicateWorkflow(
          workflow,
          second,
          ctx,
          to ? { personal: to === "user" } : {},
        );
        console.log(`Created ${copy.path}`);
        return 0;
      }
      case "rename": {
        if (!second) return usage();
        const warnings = workflowWarnings("rename", workflow, ctx);
        console.log(`Renamed to ${renameWorkflow(workflow, second, ctx).path}`);
        console.log("Runs already started keep the old name.");
        printWarnings(warnings);
        return 0;
      }
      case "move": {
        const to = placeOf(values.to);
        if (!to) return usage();
        const warnings = workflowWarnings("move", workflow, ctx);
        console.log(`Moved to ${moveWorkflow(workflow, to, ctx).path}`);
        printWarnings(warnings);
        return 0;
      }
      case "delete": {
        const warnings = workflowWarnings("delete", workflow, ctx);
        deleteWorkflow(workflow, ctx);
        console.log(`Deleted workflow ${name}. Its history is kept.`);
        printWarnings(warnings);
        return 0;
      }
      case "history":
        printHistory(workflowHistory(workflow, ctx), values.json);
        return 0;
      case "diff":
        return printDiff(workflowHistory(workflow, ctx), second, third) ? 0 : usage();
      case "switch": {
        const n = versionNumber(second);
        if (n === undefined) return usage();
        switchWorkflow(workflow, n, ctx);
        console.log(`Workflow ${name} is now at v${n}. Runs already started keep their own copy.`);
        return 0;
      }
      case "show": {
        const definition = parseWorkflow(readFileSync(workflow.path, "utf8"), name, workflow.path);
        const where = workflow.hidden
          ? "personal, hidden by the project's workflow"
          : scopeLabel(workflow.source);
        console.log(
          `${name} (${where})${definition.description ? `: ${definition.description}` : ""}\n`,
        );
        console.log(diagramText(layoutDiagram(fromDefinition(definition))).join("\n"));
        return 0;
      }
      default:
        return usage();
    }
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}
