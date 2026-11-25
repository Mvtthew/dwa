// The screens of the wizards: the menu, starting and steering workflow runs, and starting an
// agent. They
// only describe rows and what a button asks the daemon to do, so they are tested without a
// terminal.
import { APP_NAME } from "../shared/constants.ts";
import type { AgentInfo, WorkflowRunInfo, WorkspaceState } from "../shared/protocol.ts";
import { EFFORT_LEVELS } from "../shared/roles.ts";
import { describeRun, type WorkflowSummary } from "../shared/workflow.ts";
import { type RoleStore, rolesScreen } from "./role-screens.ts";
import { toolsScreen } from "./tool-screens.ts";
import type { Row, Screen } from "./wizard.ts";
import { type DesignDeps, designListScreen, newWorkflowScreen } from "./workflow-screens.ts";

export interface WizardApi {
  /** One request to the daemon; throws with the daemon's message when it refuses. */
  call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T>;
  /** Roles a session can run as. */
  roles: string[];
  /**
   * What a session of a role may use, one line each for tools, MCP servers, plugins and skills;
   * for "" the same for a session without a role. Says why when the role cannot be used.
   */
  describeRole?: (role: string) => string;
  /** Profiles from the config. */
  profiles: string[];
}

const back: Row = { kind: "button", label: "Back", run: () => ({ back: true }) };
const close: Row = { kind: "button", label: "Close", run: () => ({ close: true }) };

/** The value of a choice whose first option means "leave it to the defaults". */
const DEFAULT = "";
const orDefault = (values: string[]) => [
  { value: DEFAULT, label: "default" },
  ...values.map((value) => ({ value, label: value })),
];

export function agentScreen(api: WizardApi): Screen {
  const start = (show: boolean) => async (values: Record<string, string>) => {
    const agent = await api.call<AgentInfo>("POST", "/agents", {
      name: values.name?.trim() || undefined,
      role: values.role || undefined,
      profile: values.profile || undefined,
      model: values.otherModel?.trim() || values.model || undefined,
      effort: values.effort || undefined,
      task: values.task?.trim() || undefined,
    });
    if (show) await api.call("POST", "/agents/open", { target: agent.id });
    return { close: true as const };
  };
  const rows: Row[] = [
    { kind: "input", key: "name", label: "Name", placeholder: "agent" },
    {
      kind: "choice",
      key: "role",
      label: "Role",
      options: [{ value: DEFAULT, label: "none" }, ...orDefault(api.roles).slice(1)],
    },
  ];
  const { describeRole } = api;
  if (describeRole) {
    // Four lines, as `describeRole` gives them; it follows the role chosen above.
    rows.push({
      kind: "note",
      text: "\n\n\n",
      live: (values) =>
        describeRole(values.role ?? "")
          .split("\n")
          .map((line) => `   ${line}`)
          .join("\n"),
    });
  }
  if (api.profiles.length > 1) {
    rows.push({
      kind: "choice",
      key: "profile",
      label: "Profile",
      options: orDefault(api.profiles),
    });
  }
  rows.push(
    {
      kind: "choice",
      key: "model",
      label: "Model",
      options: orDefault(["opus", "sonnet", "haiku"]),
    },
    { kind: "input", key: "otherModel", label: "Other model", placeholder: "a full model name" },
    { kind: "choice", key: "effort", label: "Effort", options: orDefault([...EFFORT_LEVELS]) },
    { kind: "input", key: "task", label: "First task", placeholder: "optional" },
    { kind: "button", label: "Start", tone: "good", run: start(false) },
    { kind: "button", label: "Start and show it under main", tone: "good", run: start(true) },
    { kind: "button", label: "Cancel", run: () => ({ close: true }) },
  );
  return { title: "Start an agent", rows };
}

function startScreen(api: WizardApi, workflow: WorkflowSummary): Screen {
  return {
    title: `Start "${workflow.name}"`,
    rows: [
      { kind: "note", text: workflow.description ?? workflow.steps.join(" → ") },
      { kind: "input", key: "input", label: "What is this run about?", placeholder: "optional" },
      {
        kind: "button",
        label: "Start",
        tone: "good",
        run: async (values) => {
          await api.call("POST", "/workflows/run", {
            name: workflow.name,
            input: values.input?.trim() ?? "",
          });
          return { close: true };
        },
      },
      back,
    ],
  };
}

/** A screen that asks for one line of text and sends it. */
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
          return { close: true };
        },
      },
      back,
    ],
  };
}

export function runScreen(api: WizardApi, run: WorkflowRunInfo): Screen {
  const [, ...steps] = describeRun(run).split("\n");
  const rows: Row[] = [{ kind: "note", text: steps.join("\n") || "No steps." }];
  const post = (path: string, body: Record<string, unknown>) => async () => {
    await api.call("POST", path, { id: run.id, ...body });
    return { close: true as const };
  };

  if (run.state === "running") {
    for (const step of run.steps) {
      if (step.state === "rejected") {
        rows.push(
          { kind: "heading", text: `"${step.id}" still asks for changes` },
          {
            kind: "button",
            label: "Another pass",
            run: post("/workflows/step/decide", { step: step.id, decision: "another pass" }),
          },
          {
            kind: "button",
            label: "Accept the work as it is",
            run: post("/workflows/step/decide", { step: step.id, decision: "accept" }),
          },
          {
            kind: "button",
            label: "Fail the run",
            tone: "bad",
            run: post("/workflows/step/decide", { step: step.id, decision: "fail" }),
          },
        );
      }
      if (step.state !== "running") continue;
      rows.push(
        { kind: "heading", text: `Step "${step.id}"` },
        {
          kind: "button",
          label: "Complete it by hand…",
          run: () => ({
            to: textScreen(
              `Complete "${step.id}"`,
              "Result for the steps that follow",
              "Complete the step",
              (result) =>
                api.call("POST", "/workflows/step/complete", { id: run.id, step: step.id, result }),
            ),
          }),
        },
        {
          kind: "button",
          label: "Fail it…",
          tone: "bad",
          run: () => ({
            to: textScreen(`Fail "${step.id}"`, "Reason", "Fail the step and the run", (reason) =>
              api.call("POST", "/workflows/step/fail", { id: run.id, step: step.id, reason }),
            ),
          }),
        },
      );
    }
    rows.push(
      { kind: "heading", text: "Run" },
      {
        kind: "button",
        label: "Edit the steps",
        hint: "opens $EDITOR",
        run: () => ({ exec: ["workflow", "edit", String(run.id)] }),
      },
      {
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
                run: post("/workflows/cancel", {}),
              },
              back,
            ],
          },
        }),
      },
    );
  }
  rows.push(
    {
      kind: "button",
      label: "Show the results",
      run: async () => {
        const fresh = await api.call<WorkflowRunInfo>("POST", "/workflows/status", { id: run.id });
        return {
          to: {
            title: `Results of run #${run.id}`,
            rows: [{ kind: "note", text: describeRun(fresh, true) }, back],
          },
        };
      },
    },
    back,
  );
  return { title: `Run #${run.id} of "${run.name}": ${run.state}`, rows };
}

export async function workflowsScreen(api: WizardApi, design?: DesignDeps): Promise<Screen> {
  const { workflows, runs } = await api.call<{
    workflows: WorkflowSummary[];
    runs: WorkflowRunInfo[];
  }>("GET", "/workflows");
  const rows: Row[] = [{ kind: "heading", text: "START A RUN" }];
  if (workflows.length === 0) {
    rows.push({
      kind: "note",
      text: `No workflows defined. Add one with: ${APP_NAME} workflow new <name>`,
    });
  }
  for (const workflow of workflows) {
    if (workflow.error) {
      rows.push({ kind: "note", tone: "bad", text: `${workflow.name}: ${workflow.error}` });
      continue;
    }
    rows.push({
      kind: "button",
      label: workflow.name,
      hint: workflow.description ?? workflow.steps.join(" → "),
      run: () => ({ to: startScreen(api, workflow) }),
    });
  }
  rows.push({ kind: "note", text: "" }, { kind: "heading", text: "RUNS" });
  if (runs.length === 0) rows.push({ kind: "note", text: "No runs yet." });
  for (const run of runs) {
    const needsYou = run.steps.some((step) => step.needsAttention);
    rows.push({
      kind: "button",
      label: `#${run.id} ${run.name}`,
      hint: needsYou ? `${run.state} · needs you` : run.state,
      tone: needsYou ? "attention" : undefined,
      // The list may be a moment old; open the run as it is now.
      run: async () => ({
        to: runScreen(
          api,
          await api.call<WorkflowRunInfo>("POST", "/workflows/status", { id: run.id }),
        ),
      }),
    });
  }
  if (design) {
    rows.push(
      { kind: "note", text: "" },
      { kind: "heading", text: "THE WORKFLOWS THEMSELVES" },
      {
        kind: "button",
        label: "Design a workflow…",
        hint: "the steps as a picture, to change them",
        run: () => ({ to: designListScreen(design) }),
      },
      {
        kind: "button",
        label: "New workflow…",
        run: () => ({ to: newWorkflowScreen(design) }),
      },
    );
  }
  rows.push({ kind: "note", text: "" }, close);
  return { title: "Workflows", rows };
}

/** What can be done with one session: show or hide it, message it, stop it. */
function sessionScreen(api: WizardApi, agent: AgentInfo): Screen {
  const post = (path: string, body?: unknown) => async () => {
    await api.call("POST", path, body);
    return { close: true as const };
  };
  const rows: Row[] = [];
  if (agent.kind === "main") {
    rows.push({ kind: "button", label: "Focus it", run: post("/focus") });
  } else {
    rows.push({
      kind: "button",
      label: agent.open ? "Hide it" : "Show it under main",
      run: post("/agents/toggle", { target: agent.id }),
    });
  }
  rows.push({
    kind: "button",
    label: "Tools…",
    hint: "what it can use; block or allow",
    run: async () => ({ to: await toolsScreen(api, agent.id) }),
  });
  rows.push({
    kind: "button",
    label: "Send a message…",
    run: () => ({
      to: textScreen(`Message ${agent.name}`, "Message", "Send", (body) =>
        api.call("POST", "/messages", { to: agent.id, body }),
      ),
    }),
  });
  if (agent.kind !== "main") {
    rows.push({
      kind: "button",
      label: "Stop it…",
      tone: "bad",
      run: () => ({
        to: {
          title: `Stop ${agent.name}?`,
          rows: [
            { kind: "note", text: "Its session ends and its conversation is lost." },
            {
              kind: "button",
              label: "Yes, stop it",
              tone: "bad",
              run: post("/agents/stop", { target: agent.id }),
            },
            back,
          ],
        },
      }),
    });
  }
  rows.push(back);
  return { title: agent.name, rows };
}

/** The menu: everything the workspace can do, from one list. */
export async function menuScreen(
  api: WizardApi,
  roles?: RoleStore,
  design?: DesignDeps,
): Promise<Screen> {
  const state = await api.call<WorkspaceState>("GET", "/state");
  const post = (path: string, body?: unknown) => async () => {
    await api.call("POST", path, body);
    return { close: true as const };
  };
  const rows: Row[] = [];
  if (state.questions.length > 0) {
    rows.push({
      kind: "button",
      label: `Answer questions (${state.questions.length} open)`,
      tone: "attention",
      run: () => ({ exec: ["answer"] }),
    });
  }
  rows.push({ kind: "heading", text: "SESSIONS" });
  for (const agent of [...(state.main ? [state.main] : []), ...state.agents]) {
    rows.push({
      kind: "button",
      label: agent.name,
      hint: [agent.open ? "shown" : null, agent.activity.replace("_", " ")]
        .filter(Boolean)
        .join(" · "),
      tone: agent.activity === "needs_user" ? "attention" : undefined,
      run: () => ({ to: sessionScreen(api, agent) }),
    });
  }
  rows.push(
    { kind: "note", text: "" },
    { kind: "heading", text: "WORKSPACE" },
    { kind: "button", label: "Start an agent…", run: () => ({ to: agentScreen(api) }) },
    {
      kind: "button",
      label: "Workflows…",
      run: async () => ({ to: await workflowsScreen(api, design) }),
    },
    ...(roles
      ? [
          {
            kind: "button" as const,
            label: "Roles…",
            run: () => ({ to: rolesScreen(api, roles) }),
          },
        ]
      : []),
    {
      kind: "button",
      label: state.shell?.open ? "Hide the shell" : "Show the shell",
      run: post("/shell/toggle"),
    },
    { kind: "button", label: "Hide the pane under main", run: post("/agents/close") },
    {
      kind: "button",
      label: "Stop the workspace…",
      tone: "bad",
      run: () => ({
        to: {
          title: "Stop the workspace?",
          rows: [
            { kind: "note", text: "Every session in this workspace ends." },
            { kind: "button", label: "Yes, stop everything", tone: "bad", run: post("/down") },
            back,
          ],
        },
      }),
    },
    { kind: "note", text: "" },
    close,
  );
  return { title: "Menu", rows };
}
