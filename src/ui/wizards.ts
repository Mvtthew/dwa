// The screens of the wizards: the menu, starting and steering workflow runs, and starting an
// agent. They
// only describe rows and what a button asks the daemon to do, so they are tested without a
// terminal.
import { APP_NAME } from "../shared/constants.ts";
import type {
  AgentInfo,
  FeedDetail,
  FeedKind,
  WorkflowRunInfo,
  WorkspaceState,
} from "../shared/protocol.ts";
import { EFFORT_LEVELS } from "../shared/roles.ts";
import type { WorkflowSummary } from "../shared/workflow.ts";
import { ago } from "./model.ts";
import { type RoleStore, rolesScreen } from "./role-screens.ts";
import { openRun } from "./run-screens.ts";
import { leaderScreen, toolsScreen } from "./tool-screens.ts";
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

/** The messages agents sent to the user, each one whole and the newest first, and clearing them. */
export async function messagesScreen(api: WizardApi, now = Date.now()): Promise<Screen> {
  const { inbox } = await api.call<WorkspaceState>("GET", "/state");
  if (inbox.length === 0) {
    return { title: "Messages to you", rows: [{ kind: "note", text: "No messages." }, close] };
  }
  return {
    title: "Messages to you",
    rows: [
      ...inbox.flatMap((message): Row[] => [
        { kind: "heading", text: `from ${message.from}  ${ago(message.createdAt, now)}` },
        { kind: "note", text: message.body },
        { kind: "note", text: "" },
      ]),
      {
        kind: "button",
        label: "Clear messages",
        hint: "they stay stored, and are not shown again",
        run: async () => {
          await api.call("POST", "/inbox/clear");
          return { close: true };
        },
      },
      close,
    ],
  };
}

const FEED_TITLES: Record<FeedKind, string> = {
  recap: "Recap",
  spawn: "Agent started",
  finish: "Result",
  message: "Message",
  question: "Question",
  answer: "Answer",
  step: "Workflow",
  lifecycle: "Session",
  session: "New session",
};

/** What a feed item's details say, as label and value, for a spawn. */
function spawnDetails(item: FeedDetail): [string, string][] {
  const data = item.data ?? {};
  const text = (key: string) => (typeof data[key] === "string" ? (data[key] as string) : null);
  const rows: [string, string | null][] = [
    ["started by", text("startedBy") ?? "you or the workspace"],
    ["role", text("role")],
    ["profile", text("profile")],
    ["model", text("model")],
    ["effort", text("effort")],
    ["skill", text("skill")],
    ["kept", data.keep === true ? "yes, after it reports" : null],
  ];
  return rows.filter((row): row is [string, string] => row[1] !== null);
}

/**
 * One item of the event feed, whole: a recap's reply, a result, a message, or for a spawned
 * agent the task it was given and what it was started with. The session it is about can be
 * shown beside main, or its tools opened, while it runs.
 */
export async function feedScreen(api: WizardApi, id: string, now = Date.now()): Promise<Screen> {
  const item = await api.call<FeedDetail>("GET", `/feed/item?id=${encodeURIComponent(id)}`);
  const state = await api.call<WorkspaceState>("GET", "/state");
  const title = FEED_TITLES[item.kind];
  const rows: Row[] = [
    { kind: "heading", text: `${item.agent ?? APP_NAME}  ${ago(item.at, now)}` },
    { kind: "note", text: item.title },
    { kind: "note", text: "" },
  ];
  if (item.kind === "spawn") {
    rows.push({ kind: "heading", text: "Task" });
    rows.push({ kind: "note", text: item.body || "(no task: started to wait for one)" });
    rows.push({ kind: "note", text: "" }, { kind: "heading", text: "Started with" });
    const details = [...spawnDetails(item), ...(item.launch ?? [])];
    const pad = Math.max(...details.map(([label]) => label.length)) + 2;
    rows.push({
      kind: "note",
      text: details.map(([label, text]) => `${label.padEnd(pad)}${text}`).join("\n"),
    });
    rows.push({ kind: "note", text: "" });
  } else if (item.body && item.body !== item.title) {
    rows.push({ kind: "note", text: item.body }, { kind: "note", text: "" });
  }
  const sessionId = item.kind === "spawn" ? item.refId : item.agentId;
  const session = state.agents.find((agent) => agent.id === sessionId);
  if (session) {
    rows.push(
      {
        kind: "button",
        label: session.open ? `Hide ${session.name}` : `Show ${session.name}`,
        hint: "beside main",
        run: async () => {
          await api.call("POST", "/agents/toggle", { target: session.id });
          return { close: true };
        },
      },
      {
        kind: "button",
        label: "Agent tools",
        run: async () => ({ to: await toolsScreen(api, session.id) }),
      },
    );
  }
  rows.push(close);
  return { title, rows };
}

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
    { kind: "button", label: "Start and show it", tone: "good", run: start(true) },
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
      // The run opens on its picture, as it is now.
      run: () => {
        if (!design) throw new Error("Runs cannot be opened from here.");
        return openRun(design, run.id);
      },
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
      label: agent.open ? "Hide it" : "Show it",
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
      label: "Leader mode…",
      hint: "whether the main session hands work to agents",
      run: async () => ({ to: await leaderScreen(api) }),
    },
    {
      kind: "button",
      label: state.shell?.open ? "Hide the shell" : "Show the shell",
      run: post("/shell/toggle"),
    },
    { kind: "button", label: "Hide the focused agent or shell", run: post("/agents/close") },
    {
      kind: "button",
      label: "Clear the feed…",
      hint: "entries stay stored, and are not shown again",
      run: () => ({
        to: {
          title: "Clear the feed",
          rows: [
            {
              kind: "button",
              label: "Clear everything",
              hint: "the feed is empty until something happens",
              run: post("/feed/clear", { scope: "all" }),
            },
            {
              kind: "button",
              label: "Clear earlier sessions",
              hint: "keeps what follows the latest separator",
              run: post("/feed/clear", { scope: "earlier" }),
            },
            back,
          ],
        },
      }),
    },
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
