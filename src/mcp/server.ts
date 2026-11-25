// `dwa mcp`: the MCP server each session runs (over stdio) to get the dwa tools. It holds no
// state of its own; every tool is a request to the project's daemon, made as the calling agent.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { call } from "../cli/client.ts";
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
        "Wait until another agent has finished its current turn (or has stopped). Blocks with no time limit. Returns what the agent last said; for an agent you started that has reported its result and ended, the result.",
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
          if (!found) {
            // Gone: if the caller started it, the daemon knows how it ended.
            const outcome = await api<{ message: string }>("POST", "/agents/outcome", {
              target,
              from: agentId,
            });
            return outcome.message;
          }
          if (found.id === agentId) return "You cannot wait for yourself.";
          const busy = found.activity === "working" || found.activity === "starting";
          // An idle session that still owes its result is about to be reminded to report it.
          const dueSoon = found.activity === "idle" && found.reportDue && !found.waitingOn;
          if (!busy && !dueSoon) return describeAgent(found);
          await Bun.sleep(RETRY_MS);
        }
        return `Stopped waiting for ${target}.`;
      }),
  );

  server.registerTool(
    "spawn_agent",
    {
      description:
        "Start another session in this workspace. This is how work is delegated here, in place of the built-in Agent tool and its subagents. Give it a task to begin with, and the name of a role to run as. The session reports the result of the task to you as a message and then ends, unless you start it with keep. The role decides which tools, MCP servers, plugins and skills the session has; you can take some of them away for this session, but not add any.",
      inputSchema: {
        name: z.string().optional(),
        role: z
          .string()
          .optional()
          .describe("A role of this workspace (a file in .dwa/roles); list_roles shows them."),
        task: z
          .string()
          .min(1)
          .describe(
            "The first prompt for the new session. It does not see your conversation: give the goal, what done means and what you already know.",
          ),
        keep: z
          .boolean()
          .optional()
          .describe(
            "Keep the session open after it has reported its result, for follow-up tasks you send it as messages. You then end it with stop_agent.",
          ),
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
        const agent = await api<AgentInfo>("POST", "/agents", {
          ...request,
          narrowOnly: true,
          from: agentId,
        });
        return `Started agent "${agent.name}".`;
      }),
  );

  server.registerTool(
    "list_roles",
    {
      description:
        "List the roles of this workspace that work can be handed to with spawn_agent, and what each is for. Roles can change while you work; this is the list as it is now.",
    },
    () =>
      tool(async () => {
        const { roles } = await api<{ roles: string }>("POST", "/roles/list", { from: agentId });
        return roles;
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
        const agent = await api<AgentInfo>("POST", "/agents/stop", {
          target: name,
          from: agentId,
        });
        return `Stopped agent "${agent.name}".`;
      }),
  );

  server.registerTool(
    "finish_task",
    {
      description:
        "Hand over the result of the task you were started for, when another session started you with spawn_agent (your first prompt says so). The result goes to that session, and your session ends unless it was started to be kept. Not for workflow steps (complete_step) and not for notes on the way (report_progress).",
      inputSchema: {
        result: z
          .string()
          .describe(
            "Everything the session that waits needs: it gets this text and nothing else. If you could not finish, say what stopped you.",
          ),
      },
    },
    ({ result }) =>
      tool(async () => {
        const { message } = await api<{ message: string }>("POST", "/agents/finish", {
          agentId,
          result,
        });
        return message;
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
    "save_workflow",
    {
      description:
        "Write a workflow file from a complete TOML definition: a new workflow, or a new version of one that exists. The text is checked first; when something is wrong nothing is written and you are told what. The user is told about every save and sees a new workflow as a picture.",
      inputSchema: {
        name: z.string().describe("Letters, digits, - and _."),
        definition: z
          .string()
          .describe("The whole file: description and every [steps.<name>] table."),
        personal: z
          .boolean()
          .optional()
          .describe("Keep it in the user's personal folder instead of the project."),
      },
    },
    ({ name, definition, personal }) =>
      tool(async () => {
        const saved = await api<{
          name: string;
          path: string;
          version: number;
          created: boolean;
          steps: string[];
        }>("POST", "/workflows/save", { from: agentId, name, definition, personal });
        return `${saved.created ? "Created" : "Saved"} workflow "${saved.name}" (v${saved.version}) at ${saved.path}\nSteps: ${saved.steps.join(" -> ")}`;
      }),
  );

  server.registerTool(
    "save_role",
    {
      description:
        "Write a role file from a complete TOML definition. Only the session the user started to write a role may use this, and only for that role: its first version, or a new version of it. The text is checked first; when something is wrong nothing is written and you are told what. The user is told about every save and is shown a new role in the role settings.",
      inputSchema: {
        name: z.string().describe("The name you were given."),
        definition: z
          .string()
          .describe("The whole file: description, what the role may use, and its prompt."),
        personal: z
          .boolean()
          .optional()
          .describe("Keep it in the user's personal folder instead of the project."),
      },
    },
    ({ name, definition, personal }) =>
      tool(async () => {
        const saved = await api<{ name: string; path: string; version: number; created: boolean }>(
          "POST",
          "/roles/save",
          { from: agentId, name, definition, personal },
        );
        return `${saved.created ? "Created" : "Saved"} role "${saved.name}" (v${saved.version}) at ${saved.path}`;
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

  const send = (method: "GET" | "POST", path: string, body?: unknown) =>
    fetch(`http://localhost${path}`, {
      unix: socket,
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const api: Api = async <T>(method: "GET" | "POST", path: string, body?: unknown) => {
    let response: Response;
    try {
      response = await send(method, path, body);
    } catch (error) {
      // The daemon is gone. While the workspace runs it can be started again, which the
      // shared client does; then the tool call is made once more.
      if (!env.DWA_PROJECT) throw error;
      await call(env.DWA_PROJECT, "GET", "/ping");
      response = await send(method, path, body);
    }
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new ApiError(data.error ?? `HTTP ${response.status}`);
    return data;
  };

  await createMcpServer(agentId, api).connect(new StdioServerTransport());
}
