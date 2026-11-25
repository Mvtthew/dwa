// `dwa mcp`: the MCP server each session runs (over stdio) to get the dwa tools. It holds no
// state of its own; every tool is a request to the project's daemon, made as the calling agent.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { APP_NAME } from "../shared/constants.ts";
import { daemonSocketPath } from "../shared/paths.ts";
import type {
  AgentInfo,
  WorkflowEdit,
  WorkflowRunInfo,
  WorkspaceState,
} from "../shared/protocol.ts";
import { EFFORT_LEVELS } from "../shared/roles.ts";
import { describeRun, type WorkflowSummary } from "../shared/workflow.ts";

type Env = Record<string, string | undefined>;

interface Question {
  id: number;
  state: "open" | "answered" | "cancelled";
  answer: string | null;
}

/** The daemon answered with an error (as opposed to not answering at all). */
export class ApiError extends Error {}

const RETRY_MS = 2000;

function reply(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

export function describeAgent(agent: AgentInfo): string {
  const parts = [agent.activity.replace("_", " ")];
  if (agent.waitingOn) parts.push(`waiting on ${agent.waitingOn}`);
  if (agent.progress) parts.push(agent.progress);
  else if (agent.detail) parts.push(agent.detail);
  const role = agent.role && agent.role !== agent.name ? ` (${agent.role})` : "";
  return `${agent.name}${role}: ${parts.join(" · ")}`;
}

/** One request to the daemon. Throws `ApiError` when the daemon answers with an error. */
export type Api = <T>(method: "GET" | "POST", path: string, body?: unknown) => Promise<T>;

/** The dwa tools as an MCP server, for the agent with this id. Not yet connected to a transport. */
export function createMcpServer(agentId: string, api: Api): McpServer {
  /** Runs a tool body and turns a daemon error into a tool error the model can read. */
  const tool = async (run: () => Promise<string>) => {
    try {
      return reply(await run());
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : `The ${APP_NAME} daemon could not be reached: ${(error as Error).message}`;
      return reply(message, true);
    }
  };

  /** Waits for the outcome of a question for as long as it takes, across daemon restarts. */
  const waitForAnswer = async (id: number, signal: AbortSignal): Promise<Question | null> => {
    while (!signal.aborted) {
      try {
        const question = await api<Question>("POST", "/questions/wait", { id });
        if (question.state !== "open") return question;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        await Bun.sleep(RETRY_MS);
      }
    }
    return null;
  };

  const server = new McpServer({ name: APP_NAME, version: "0.0.0" });

  server.registerTool(
    "list_agents",
    { description: "List the sessions running in this workspace and what each is doing." },
    () =>
      tool(async () => {
        const state = await api<WorkspaceState>("GET", "/state");
        const everyone = [...(state.main ? [state.main] : []), ...state.agents];
        const lines = everyone.map(
          (agent) => `${describeAgent(agent)}${agent.id === agentId ? "  (you)" : ""}`,
        );
        return lines.join("\n") || "No sessions are running.";
      }),
  );

  server.registerTool(
    "send_message",
    {
      description:
        'Send a message to another agent (by name) or to the user ("user"). Does not wait for a reply. To get an answer back, use ask.',
      inputSchema: { to: z.string(), message: z.string() },
    },
    ({ to, message }) =>
      tool(async () => {
        const sent = await api<{ to: string }>("POST", "/messages", {
          from: agentId,
          to,
          body: message,
        });
        return `Message sent to ${sent.to}.`;
      }),
  );

  server.registerTool(
    "ask",
    {
      description:
        'Ask another agent (by name) or the user ("user") a question and wait for the answer. This call blocks until someone answers; there is no time limit. Use it when you need a decision before continuing.',
      inputSchema: {
        to: z.string(),
        question: z.string(),
        options: z.array(z.string()).optional().describe("Suggested answers, if there are any."),
      },
    },
    ({ to, question, options }, extra) =>
      tool(async () => {
        const asked = await api<Question>("POST", "/questions", {
          from: agentId,
          to,
          question,
          options,
        });
        const result = await waitForAnswer(asked.id, extra.signal);
        if (!result)
          return `Question #${asked.id} is still open. Its answer will reach you as a message.`;
        if (result.state === "cancelled") {
          return `Question #${asked.id} was cancelled${result.answer ? `: ${result.answer}` : "."}`;
        }
        return `Answer from ${to}: ${result.answer}`;
      }),
  );

  server.registerTool(
    "answer",
    {
      description:
        "Answer a question that was addressed to you. The question id is in the message.",
      inputSchema: { question_id: z.number().int(), answer: z.string() },
    },
    ({ question_id, answer }) =>
      tool(async () => {
        await api("POST", "/questions/answer", { id: question_id, by: agentId, answer });
        return `Answer to question #${question_id} delivered.`;
      }),
  );

  server.registerTool(
    "report_progress",
    {
      description:
        "Publish a one-line note about where you are in your task. It is shown on the workspace dashboard.",
      inputSchema: {
        summary: z.string(),
        percent: z.number().min(0).max(100).optional(),
      },
    },
    ({ summary, percent }) =>
      tool(async () => {
        await api("POST", "/progress", { agentId, summary, percent });
        return "Progress noted.";
      }),
  );

  server.registerTool(
    "wait_for",
    {
      description:
        "Wait until another agent has finished its current turn (or has stopped). Blocks with no time limit. Returns what the agent last said.",
      inputSchema: { agent: z.string() },
    },
    ({ agent: target }, extra) =>
      tool(async () => {
        while (!extra.signal.aborted) {
          let state: WorkspaceState;
          try {
            state = await api<WorkspaceState>("GET", "/state");
          } catch (error) {
            if (error instanceof ApiError) throw error;
            await Bun.sleep(RETRY_MS);
            continue;
          }
          const everyone = [...(state.main ? [state.main] : []), ...state.agents];
          const found = everyone.find((agent) => agent.name === target || agent.id === target);
          if (!found) return `${target} is not running.`;
          if (found.id === agentId) return "You cannot wait for yourself.";
          if (found.activity !== "working" && found.activity !== "starting") {
            return describeAgent(found);
          }
          await Bun.sleep(RETRY_MS);
        }
        return `Stopped waiting for ${target}.`;
      }),
  );

  server.registerTool(
    "spawn_agent",
    {
      description:
        "Start another session in this workspace. Give it a task to begin with, and the name of a role to run as. The role decides which tools, MCP servers, plugins and skills the session has; you can take some of them away for this session, but not add any.",
      inputSchema: {
        name: z.string().optional(),
        role: z.string().optional().describe("A role of this workspace (a file in .dwa/roles)."),
        task: z.string().optional().describe("The first prompt for the new session."),
        profile: z.string().optional(),
        model: z
          .string()
          .optional()
          .describe("Only to override; by default the role or the workspace decides."),
        effort: z.enum(EFFORT_LEVELS).optional(),
        deny_tools: z
          .array(z.string())
          .optional()
          .describe("Built-in tools to take away from the role, such as Edit or Bash."),
        deny: z
          .array(z.string())
          .optional()
          .describe("Extra permission rules to refuse, such as Bash(git push *)."),
        mcp: z.array(z.string()).optional().describe("Keep only these of the role's MCP servers."),
        plugins: z.array(z.string()).optional().describe("Keep only these of the role's plugins."),
        skills: z.array(z.string()).optional().describe("Keep only these of the role's skills."),
      },
    },
    (request) =>
      tool(async () => {
        const agent = await api<AgentInfo>("POST", "/agents", { ...request, narrowOnly: true });
        return `Started agent "${agent.name}".`;
      }),
  );

  server.registerTool(
    "stop_agent",
    {
      description: "End another agent's session. Its unsaved conversation context is lost.",
      inputSchema: { name: z.string() },
    },
    ({ name }) =>
      tool(async () => {
        const agent = await api<AgentInfo>("POST", "/agents/stop", { target: name });
        return `Stopped agent "${agent.name}".`;
      }),
  );

  server.registerTool(
    "list_workflows",
    {
      description:
        "List the workflows defined for this project and the runs in progress. A workflow is a fixed sequence of steps, each done by its own agent.",
    },
    () =>
      tool(async () => {
        const { workflows, runs } = await api<{
          workflows: WorkflowSummary[];
          runs: WorkflowRunInfo[];
        }>("GET", "/workflows");
        const lines = workflows.map((workflow) =>
          workflow.error
            ? `${workflow.name}: invalid (${workflow.error})`
            : `${workflow.name}: ${workflow.description ?? workflow.steps.join(" -> ")}`,
        );
        if (lines.length === 0) lines.push("No workflows are defined (.dwa/workflows/*.toml).");
        for (const run of runs) lines.push("", describeRun(run));
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "run_workflow",
    {
      description:
        "Start a run of a workflow. Returns at once; when the run ends you get a message with its outcome. Do not wait or poll for it.",
      inputSchema: {
        name: z.string(),
        input: z.string().optional().describe("What the run is about; steps receive it."),
      },
    },
    ({ name, input }) =>
      tool(async () => {
        const run = await api<WorkflowRunInfo>("POST", "/workflows/run", {
          from: agentId,
          name,
          input,
        });
        return `Started. You will get a message when it ends.\n${describeRun(run)}`;
      }),
  );

  server.registerTool(
    "workflow_status",
    {
      description: "Show a workflow run: the state of each step and the results so far.",
      inputSchema: { run_id: z.number().int() },
    },
    ({ run_id }) =>
      tool(async () =>
        describeRun(await api<WorkflowRunInfo>("POST", "/workflows/status", { id: run_id }), true),
      ),
  );

  server.registerTool(
    "workflow_definition",
    {
      description:
        "Get the definition a workflow run is working from, as TOML. It is the run's own copy; read it before edit_workflow.",
      inputSchema: { run_id: z.number().int() },
    },
    ({ run_id }) =>
      tool(async () => {
        const { definition } = await api<{ definition: string }>("POST", "/workflows/definition", {
          id: run_id,
        });
        return definition;
      }),
  );

  server.registerTool(
    "edit_workflow",
    {
      description:
        "Change a workflow run in progress by replacing its definition (the full TOML, as workflow_definition gives it, with your changes). Steps that have not started follow the new text. A changed step that has started runs again, with every started step after it, and agents working on those are stopped, so change only what you mean to. The user is told what you changed.",
      inputSchema: { run_id: z.number().int(), definition: z.string() },
    },
    ({ run_id, definition }) =>
      tool(async () => {
        const edit = await api<WorkflowEdit>("POST", "/workflows/edit", {
          id: run_id,
          definition,
          from: agentId,
        });
        if (edit.changes.length === 0) return "Nothing changed: the definition is the same.";
        return `${edit.changes.join("\n")}\n\n${describeRun(edit.run)}`;
      }),
  );

  server.registerTool(
    "complete_step",
    {
      description:
        "Finish the workflow step you were started for. The result is handed to the steps that follow, so make it complete and self-contained. Your session ends after this unless the workflow keeps it.",
      inputSchema: { result: z.string() },
    },
    ({ result }) =>
      tool(async () => {
        await api("POST", "/workflows/step/complete", { agentId, result });
        return "Step completed.";
      }),
  );

  server.registerTool(
    "request_changes",
    {
      description:
        "Only for a workflow step that reviews another step (your first prompt says so): send the reviewed work back for another pass instead of approving it. The feedback goes to the agent that did the work, so say exactly what must change. Your session ends after this; the next review pass is told what you asked for.",
      inputSchema: { feedback: z.string() },
    },
    ({ feedback }) =>
      tool(async () => {
        await api("POST", "/workflows/step/changes", { agentId, feedback });
        return "Changes requested.";
      }),
  );

  server.registerTool(
    "fail_step",
    {
      description:
        "Give up on the workflow step you were started for, with the reason. The workflow run fails. Use ask first if a decision from someone could unblock you.",
      inputSchema: { reason: z.string() },
    },
    ({ reason }) =>
      tool(async () => {
        await api("POST", "/workflows/step/fail", { agentId, reason });
        return "Step marked as failed.";
      }),
  );

  return server;
}

export async function runMcp(env: Env = process.env): Promise<void> {
  const agentId = env.DWA_AGENT_ID ?? "";
  const socket = env.DWA_SOCKET || daemonSocketPath(env.DWA_PROJECT ?? process.cwd());

  const api: Api = async <T>(method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`http://localhost${path}`, {
      unix: socket,
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new ApiError(data.error ?? `HTTP ${response.status}`);
    return data;
  };

  await createMcpServer(agentId, api).connect(new StdioServerTransport());
}
