// The workflow designer's access to the files: the workflows themselves, their history, the
// templates dwa ships, and the drafts that keep unsaved work. `diskWorkflowStore` is the real
// one, for the popup; the screens are tested with their own.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Config } from "../shared/config.ts";
import { diffLines, type History, readHistory, versionText } from "../shared/history.ts";
import { projectSkillsDir, runDir, skillsDir, userSkillsDir } from "../shared/paths.ts";
import { listRoles } from "../shared/roles.ts";
import { type Scope, type ScopeContext, scopeLabel } from "../shared/scope.ts";
import { listAllWorkflows, parseWorkflow, summarizeWorkflow } from "../shared/workflow.ts";
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  moveWorkflow,
  noticeWorkflowEdits,
  renameWorkflow,
  requireWorkflow,
  saveWorkflowText,
  switchWorkflow,
  type WorkflowRef,
  workflowHistory,
  workflowWarnings,
} from "../shared/workflow-edit.ts";
import type { DesignTarget } from "./designer-model.ts";

export interface WorkflowListEntry {
  name: string;
  source: Scope;
  /** A personal workflow the project has one of the same name for; a run here uses that one. */
  hidden: boolean;
  description: string | null;
  steps: string[];
  /** Why the file cannot be run, when it cannot. It can still be opened and put right. */
  error: string | null;
}

/** Unsaved work on a workflow or a run, kept so that closing the popup loses nothing. */
export interface Draft {
  v: 1;
  target: DesignTarget;
  /** The text the work started from; when the file no longer has it, the file changed since. */
  base: string;
  text: string;
  undo: string[];
  redo: string[];
  renames: Record<string, string>;
  savedAt: string;
}

export interface Template {
  name: string;
  description: string;
  text: string;
}

/** What the workflow screens need from the files. Every method may throw with a message to show. */
export interface WorkflowStore {
  /** Every workflow file in both places, the hidden personal ones included. */
  list(): WorkflowListEntry[];
  /** The file's text. */
  read(workflow: WorkflowRef): string;
  /** Writes a valid text. Returns the version the file is at afterwards. */
  save(workflow: WorkflowRef, text: string): number;
  create(name: string, text: string, where: Scope): void;
  /** Without `where` the copy is kept where the original is. */
  duplicate(from: WorkflowRef, to: string, where?: Scope): void;
  rename(from: WorkflowRef, to: string): void;
  move(workflow: WorkflowRef, to: Scope): void;
  remove(workflow: WorkflowRef): void;
  /** What the change means outside this project's files. */
  warnings(action: "rename" | "delete" | "move", workflow: WorkflowRef): string[];
  history(workflow: WorkflowRef): History;
  diff(workflow: WorkflowRef, from: number, to: number): string[];
  switchTo(workflow: WorkflowRef, n: number): void;
  /** The workflows dwa ships, to start a new one from. */
  templates(): Template[];
  /** Names a step can pick from. */
  choices(): {
    roles: string[];
    profiles: string[];
    mcp: string[];
    plugins: string[];
    skills: string[];
    projectMcp: string[];
  };
  draft(target: DesignTarget): Draft | null;
  putDraft(draft: Draft): void;
  clearDraft(target: DesignTarget): void;
}

const TEMPLATES_DIR = join(import.meta.dir, "..", "..", "examples", "workflows");

function skillNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, "SKILL.md")));
}

function projectServers(projectRoot: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(projectRoot, ".mcp.json"), "utf8"));
    return Object.keys(parsed?.mcpServers ?? parsed ?? {});
  } catch {
    return [];
  }
}

/** The file a target's draft is kept in, under the run folder, which is never committed. */
export function draftPath(projectRoot: string, target: DesignTarget): string {
  const file =
    target.kind === "run"
      ? `run-${target.id}.json`
      : `workflow-${scopeLabel(target.source)}-${target.name}.json`;
  return join(runDir(projectRoot), "drafts", file);
}

/** The shipped workflows, by name. A file that does not validate is left out. */
export function readTemplates(dir: string = TEMPLATES_DIR): Template[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".toml"))
    .sort()
    .flatMap((file) => {
      const name = file.slice(0, -".toml".length);
      const text = readFileSync(join(dir, file), "utf8");
      try {
        return [{ name, description: parseWorkflow(text, name).description ?? "", text }];
      } catch {
        return [];
      }
    });
}

export function diskWorkflowStore(
  projectRoot: string,
  config: Config | null,
  env?: Record<string, string | undefined>,
): WorkflowStore {
  const ctx: ScopeContext = { projectRoot, env };
  // Whatever was changed in an editor since the last look gets its version first.
  noticeWorkflowEdits(ctx);
  const SOURCE = "workflow designer";
  return {
    list: () =>
      listAllWorkflows(ctx).map((entry) => {
        const { description, steps, error } = summarizeWorkflow(entry);
        return {
          name: entry.name,
          source: entry.source,
          hidden: entry.hidden,
          description,
          steps,
          error,
        };
      }),
    read: (workflow) => readFileSync(requireWorkflow(workflow, ctx).path, "utf8"),
    save: (workflow, text) => saveWorkflowText(workflow, text, SOURCE, ctx).n,
    create: (name, text, where) => {
      createWorkflow(name, text, SOURCE, ctx, { personal: where === "user" });
    },
    duplicate: (from, to, where) => {
      duplicateWorkflow(from, to, ctx, where ? { personal: where === "user" } : {});
    },
    rename: (from, to) => {
      renameWorkflow(from, to, ctx);
    },
    move: (workflow, to) => {
      moveWorkflow(workflow, to, ctx);
    },
    remove: (workflow) => deleteWorkflow(workflow, ctx),
    warnings: (action, workflow) => workflowWarnings(action, workflow, ctx),
    history: (workflow) => readHistory(workflowHistory(workflow, ctx)),
    diff: (workflow, from, to) => {
      const tracked = workflowHistory(workflow, ctx);
      const lines = diffLines(versionText(tracked, from), versionText(tracked, to));
      return lines.length > 0 ? lines : ["No differences."];
    },
    switchTo: (workflow, n) => {
      switchWorkflow(workflow, n, ctx);
    },
    templates: () => readTemplates(),
    choices: () => ({
      roles: listRoles({ projectRoot, env }).map((role) => role.name),
      profiles: Object.keys(config?.profiles ?? {}),
      mcp: Object.keys(config?.mcp ?? {}),
      plugins: Object.keys(config?.plugins ?? {}),
      skills: [
        ...new Set([
          ...skillNames(projectSkillsDir(projectRoot)),
          ...skillNames(skillsDir(projectRoot)),
          ...skillNames(userSkillsDir(env)),
        ]),
      ],
      projectMcp: projectServers(projectRoot),
    }),
    draft: (target) => {
      try {
        const draft = JSON.parse(readFileSync(draftPath(projectRoot, target), "utf8")) as Draft;
        return draft.v === 1 && typeof draft.text === "string" ? draft : null;
      } catch {
        return null;
      }
    },
    putDraft: (draft) => {
      const path = draftPath(projectRoot, draft.target);
      mkdirSync(join(path, ".."), { recursive: true });
      // Written whole and moved into place, so a crash never leaves half a draft.
      writeFileSync(`${path}.tmp`, JSON.stringify(draft));
      renameSync(`${path}.tmp`, path);
    },
    clearDraft: (target) => rmSync(draftPath(projectRoot, target), { force: true }),
  };
}
