import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type Api, ApiError, createMcpServer } from "../src/mcp/server.ts";
import type { AgentInfo, WorkflowRunInfo } from "../src/shared/protocol.ts";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (body: Record<string, unknown>) => unknown;

let calls: Call[];
let routes: Record<string, Handler>;
let client: Client;

const run: WorkflowRunInfo = {
  id: 4,
  name: "feature",
  input: "x",
  state: "running",
  startedBy: "main",
  createdAt: 0,
  finishedAt: null,
  steps: [
    {
      id: "build",
      state: "done",
      attempt: 1,
      dependsOn: [],
      agent: "build",
      result: "built it",
      error: null,
      needsAttention: false,
    },
  ],
};

function agent(id: string, name: string, activity: AgentInfo["activity"]): AgentInfo {
  return { id, name, role: null, activity, detail: null, progress: null } as AgentInfo;
}

beforeEach(async () => {
  calls = [];
  routes = {};
  const api: Api = async <T>(method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new ApiError(`no route ${method} ${path}`);
    return handler((body ?? {}) as Record<string, unknown>) as T;
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer("agent-1", api).connect(serverSide);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
});

/** Calls a tool and returns its text and whether it was an error. */
async function use(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  return { text: first?.text ?? "", isError: result.isError === true };
}

describe("the dwa tools", () => {
  test("every tool is offered", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "answer",
      "ask",
      "complete_step",
      "edit_workflow",
      "fail_step",
      "list_agents",
      "list_workflows",
      "report_progress",
      "request_changes",
      "run_workflow",
      "save_role",
      "save_workflow",
      "send_message",
      "spawn_agent",
      "stop_agent",
      "wait_for",
      "workflow_definition",
      "workflow_status",
    ]);
  });

  test("a daemon error becomes a tool error the model can read", async () => {
    routes["POST /messages"] = () => {
      throw new ApiError('No running agent "ghost".');
    };
    expect(await use("send_message", { to: "ghost", message: "hi" })).toEqual({
      text: 'No running agent "ghost".',
      isError: true,
    });
  });

  test("a daemon that cannot be reached is reported as such", async () => {
    routes["POST /progress"] = () => {
      throw new Error("connection refused");
    };
    const result = await use("report_progress", { summary: "halfway" });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("The dwa daemon could not be reached: connection refused");
  });

  test("arguments that do not fit the schema never reach the daemon", async () => {
    const result = await use("workflow_status", { run_id: "four" });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("agents and messages", () => {
  test("list_agents marks the caller", async () => {
    routes["GET /state"] = () => ({
      main: agent("main-id", "main", "idle"),
      agents: [agent("agent-1", "build", "working")],
    });
    expect((await use("list_agents")).text).toBe("main: idle\nbuild: working  (you)");
  });

  test("send_message, answer and report_progress act as the calling agent", async () => {
    routes["POST /messages"] = () => ({ id: 1, to: "main" });
    routes["POST /questions/answer"] = () => ({});
    routes["POST /progress"] = () => ({ ok: true });
    expect((await use("send_message", { to: "main", message: "done" })).text).toBe(
      "Message sent to main.",
    );
    await use("answer", { question_id: 7, answer: "yes" });
    await use("report_progress", { summary: "halfway", percent: 50 });
    expect(calls.map((call) => call.body)).toEqual([
      { from: "agent-1", to: "main", body: "done" },
      { id: 7, by: "agent-1", answer: "yes" },
      { agentId: "agent-1", summary: "halfway", percent: 50 },
    ]);
  });

  test("ask waits for the answer, and reports a cancelled question", async () => {
    routes["POST /questions"] = () => ({ id: 3, state: "open", answer: null });
    routes["POST /questions/wait"] = () => ({ id: 3, state: "answered", answer: "blue" });
    expect((await use("ask", { to: "user", question: "Which?", options: ["red"] })).text).toBe(
      "Answer from user: blue",
    );
    expect(calls[0]?.body).toEqual({
      from: "agent-1",
      to: "user",
      question: "Which?",
      options: ["red"],
    });

    routes["POST /questions/wait"] = () => ({ id: 3, state: "cancelled", answer: "user stopped" });
    expect((await use("ask", { to: "user", question: "Which?" })).text).toBe(
      "Question #3 was cancelled: user stopped",
    );
  });

  test("wait_for returns at once for an agent that is not working, and refuses the caller", async () => {
    routes["GET /state"] = () => ({
      main: null,
      agents: [agent("agent-1", "build", "working"), agent("a2", "review", "idle")],
    });
    expect((await use("wait_for", { agent: "review" })).text).toBe("review: idle");
    expect((await use("wait_for", { agent: "build" })).text).toBe("You cannot wait for yourself.");
    expect((await use("wait_for", { agent: "nobody" })).text).toBe("nobody is not running.");
  });

  test("spawn_agent and stop_agent pass the request on", async () => {
    routes["POST /agents"] = () => agent("a9", "helper", "starting");
    routes["POST /agents/stop"] = () => agent("a9", "helper", "idle");
    const spawned = await use("spawn_agent", { role: "explore", task: "look", effort: "low" });
    expect(spawned.text).toBe('Started agent "helper".');
    // Marked as an agent's request, so the daemon lets it narrow the role and nothing more.
    expect(calls[0]?.body).toEqual({
      role: "explore",
      task: "look",
      effort: "low",
      narrowOnly: true,
    });
    expect((await use("stop_agent", { name: "helper" })).text).toBe('Stopped agent "helper".');
    expect(calls[1]?.body).toEqual({ target: "helper" });
    expect((await use("spawn_agent", { effort: "extreme" })).isError).toBe(true);
  });
});

describe("workflows", () => {
  test("list_workflows shows definitions, broken files and runs", async () => {
    routes["GET /workflows"] = () => ({
      workflows: [
        { name: "feature", description: null, steps: ["explore", "build"], error: null },
        { name: "broken", description: null, steps: [], error: "invalid TOML" },
      ],
      runs: [run],
    });
    expect((await use("list_workflows")).text).toBe(
      [
        "feature: explore -> build",
        "broken: invalid (invalid TOML)",
        "",
        'Run #4 of "feature": running (started by main)',
        "  build: done",
      ].join("\n"),
    );
  });

  test("run_workflow starts a run as the caller; workflow_status includes results", async () => {
    routes["POST /workflows/run"] = () => run;
    routes["POST /workflows/status"] = () => run;
    const started = await use("run_workflow", { name: "feature", input: "x" });
    expect(started.text).toStartWith("Started. You will get a message when it ends.");
    expect(calls[0]?.body).toEqual({ from: "agent-1", name: "feature", input: "x" });
    expect((await use("workflow_status", { run_id: 4 })).text).toContain("      built it");
    expect(calls[1]?.body).toEqual({ id: 4 });
  });

  test("a step is ended as the calling agent", async () => {
    routes["POST /workflows/step/complete"] = () => run;
    routes["POST /workflows/step/fail"] = () => run;
    routes["POST /workflows/step/changes"] = () => run;
    expect((await use("complete_step", { result: "done" })).text).toBe("Step completed.");
    expect((await use("fail_step", { reason: "blocked" })).text).toBe("Step marked as failed.");
    expect((await use("request_changes", { feedback: "add tests" })).text).toBe(
      "Changes requested.",
    );
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/workflows/step/complete",
        body: { agentId: "agent-1", result: "done" },
      },
      {
        method: "POST",
        path: "/workflows/step/fail",
        body: { agentId: "agent-1", reason: "blocked" },
      },
      {
        method: "POST",
        path: "/workflows/step/changes",
        body: { agentId: "agent-1", feedback: "add tests" },
      },
    ]);
  });

  test("a run's definition can be read and replaced", async () => {
    routes["POST /workflows/definition"] = () => ({ definition: '[steps.build]\nprompt = "b"\n' });
    routes["POST /workflows/edit"] = (body) => ({
      run,
      changes: body.definition === "same" ? [] : ['added "docs"'],
      restarts: false,
      applied: body.definition !== "same",
    });
    expect((await use("workflow_definition", { run_id: 4 })).text).toBe(
      '[steps.build]\nprompt = "b"\n',
    );
    const edited = await use("edit_workflow", { run_id: 4, definition: "new" });
    expect(edited.text).toStartWith('added "docs"\n\nRun #4 of "feature"');
    expect(calls[1]?.body).toEqual({ id: 4, definition: "new", from: "agent-1" });
    expect((await use("edit_workflow", { run_id: 4, definition: "same" })).text).toBe(
      "Nothing changed: the definition is the same.",
    );
  });
});
