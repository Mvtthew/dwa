// `dwa mcp`: the MCP server each session runs (over stdio) to get the dwa tools. It holds no
// state of its own; every tool is a request to the project's daemon, made as the calling agent.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { APP_NAME } from "../shared/constants.ts";
import { daemonSocketPath } from "../shared/paths.ts";
import type { AgentInfo, WorkspaceState } from "../shared/protocol.ts";

type Env = Record<string, string | undefined>;

interface Question {
  id: number;
  state: "open" | "answered" | "cancelled";
  answer: string | null;
}

/** The daemon answered with an error (as opposed to not answering at all). */
class ApiError extends Error {}

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

export async function runMcp(env: Env = process.env): Promise<void> {
  const agentId = env.DWA_AGENT_ID ?? "";
  const socket = env.DWA_SOCKET || daemonSocketPath(env.DWA_PROJECT ?? process.cwd());

  const api = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`http://localhost${path}`, {
      unix: socket,
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new ApiError(data.error ?? `HTTP ${response.status}`);
    return data;
  };

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
        "Start another session in this workspace. Give it a task to begin with, and optionally the name of an agent definition (role) to run as.",
      inputSchema: {
        name: z.string().optional(),
        role: z.string().optional().describe("An agent definition from .claude/agents."),
        task: z.string().optional().describe("The first prompt for the new session."),
        profile: z.string().optional(),
      },
    },
    (request) =>
      tool(async () => {
        const agent = await api<AgentInfo>("POST", "/agents", request);
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

  await server.connect(new StdioServerTransport());
}
