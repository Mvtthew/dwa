// `dwa mcp`: the MCP server each session runs (over stdio) to get the dwa tools. It holds no
// state of its own; every tool is a request to the project's daemon, made as the calling agent.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { call } from "../cli/client.ts";
import { APP_NAME } from "../shared/constants.ts";
import { daemonSocketPath } from "../shared/paths.ts";
import type {
  AgentInfo,
  QuestionInfo,
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

/** One line as a leader sees it: also who started the session, its task and what it has used. */
export function describeAgentFully(agent: AgentInfo): string {
  const parts = [describeAgent(agent)];
  if (agent.startedBy) parts.push(`started by ${agent.startedBy}`);
  const context = agent.telemetry?.contextPercent;
  if (context != null) parts.push(`context ${Math.round(context)}%`);
  const cost = agent.telemetry?.costUsd;
  if (cost != null) parts.push(`$${cost.toFixed(2)}`);
  if (agent.outOfDate) parts.push("behind its role's files");
  const line = parts.join(" · ");
  const task = agent.task?.split("\n---\n")[0]?.trim().split("\n")[0];
  if (!task) return line;
  return `${line}\n  task: ${task.length > 160 ? `${task.slice(0, 159)}…` : task}`;
}

export function describeAgent(agent: AgentInfo): string {
  const parts = [agent.activity.replace("_", " ")];
  if (agent.waitingOn) parts.push(`waiting on ${agent.waitingOn}`);
  if (agent.progress) parts.push(agent.progress);
  else if (agent.detail) parts.push(agent.detail);
  const role = agent.role && agent.role !== agent.name ? ` (${agent.role})` : "";
  return `${agent.name}${role}: ${parts.join(" · ")}`;
}

/** What `wait_for` returns when the awaited agent is itself blocked on a question to the caller. */
function askedYou(name: string, asked: QuestionInfo): string {
  const lines = [`${name} is not finished: it asked you a question and waits for the answer.`, ""];
  lines.push(`Question #${asked.id}: ${asked.question}`);
  if (asked.options.length > 0) lines.push(`Suggested answers: ${asked.options.join(" | ")}`);
  lines.push(
    "",
    `Give the answer with the "answer" tool (question_id: ${asked.id}), then wait for ${name} again. If you are not sure of the answer, or the decision is the user's, put it to the user with "ask" first and pass on what they say. The same question may still reach you as a message; it needs no second answer.`,
  );
  return lines.join("\n");
}

/** One request to the daemon. Throws `ApiError` when the daemon answers with an error. */
export type Api = <T>(method: "GET" | "POST", path: string, body?: unknown) => Promise<T>;

/** The dwa tools as an MCP server, for the agent with this id. Not yet connected to a transport. */
export interface McpOptions {
  /** The session leads: it gets the tools for leading, and more about each agent. */
  leader?: boolean;
  /** The session looks into reports of a gap: it gets the tools for settling them. */
  selfheal?: boolean;
  /** The session does not get the tool for reporting a gap in its own setup. */
  noReport?: boolean;
}

/** Where a report of a gap stands, as the daemon answers a reporter that waits. */
interface ReportStatus {
  id: number;
  state: string;
  outcome?: string;
  question?: QuestionInfo;
}

export function createMcpServer(agentId: string, api: Api, options: McpOptions = {}): McpServer {
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

  const server = new McpServer({ name: APP_NAME, version: pkg.version });

  server.registerTool(
    "list_agents",
    { description: "List the sessions running in this workspace and what each is doing." },
    () =>
      tool(async () => {
        const state = await api<WorkspaceState>("GET", "/state");
        const everyone = [...(state.main ? [state.main] : []), ...state.agents];
        const describe = options.leader ? describeAgentFully : describeAgent;
        const lines = everyone.map((agent) => {
          const [first = "", ...rest] = describe(agent).split("\n");
          return [`${first}${agent.id === agentId ? "  (you)" : ""}`, ...rest].join("\n");
        });
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
        "Wait until another agent has finished its current turn (or has stopped). Blocks with no time limit. Returns what the agent last said; for an agent you started that has reported its result and ended, the result. Returns early with the question when that agent asks you one.",
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
          // It asked the caller: waiting on would leave both blocked on each other, and the
          // question itself only reaches the caller as a message once this turn is over.
          const asked = (state.questions ?? []).find(
            (question) => question.fromId === found.id && question.toId === agentId,
          );
          if (asked) return askedYou(found.name, asked);
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
        skill: z
          .string()
          .optional()
          .describe(
            "Run this skill as the session's task: for the skills your instructions list as running as their own agent. The task is then what the skill should work on.",
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

  if (!options.noReport) {
    server.registerTool(
      "report_gap",
      {
        description: `Report that your own setup does not fit your task: your role is not suited to it, a tool, skill, MCP server or permission you need is missing or was refused, or ${APP_NAME} itself misbehaved. A session made for this looks into it and either tells you how to do it with what you have, or proposes a change that the user decides on; when it is approved you are restarted with it and carry on. Do not work around a refusal instead. With blocking the call waits for the outcome, with no time limit: use it when you cannot go on without the missing thing. Without it you carry on and get the outcome as a message.`,
        inputSchema: {
          what: z
            .string()
            .optional()
            .describe(
              "What you needed, for which part of your task, and what happened when you tried: the exact tool, command, skill or refusal text.",
            ),
          tried: z.string().optional().describe("What you tried instead, if anything."),
          blocking: z.boolean().optional().describe("Wait here for the outcome."),
          report_id: z
            .number()
            .int()
            .optional()
            .describe("Wait for a report you made earlier instead of making a new one."),
        },
      },
      ({ what, tried, blocking, report_id }, extra) =>
        tool(async () => {
          let id = report_id;
          if (id === undefined) {
            if (!what) return "Say what you needed and what happened (what).";
            const receipt = await api<{ id: number; selfheal: string; joined: boolean }>(
              "POST",
              "/selfheal/reports",
              { from: agentId, what, tried, blocking },
            );
            id = receipt.id;
            if (!blocking) {
              return `Report #${id} is with ${receipt.selfheal}. Carry on with what you can do; the outcome reaches you as a message. If you cannot go on without it, call report_gap again with report_id ${id} and blocking.`;
            }
          }
          let first = true;
          while (!extra.signal.aborted) {
            let status: ReportStatus;
            try {
              status = await api<ReportStatus>("POST", "/selfheal/status", {
                id,
                from: agentId,
                ...(first ? { waiting: true } : {}),
              });
              first = false;
            } catch (error) {
              if (error instanceof ApiError) throw error;
              await Bun.sleep(RETRY_MS);
              continue;
            }
            if (status.state !== "open") return `Report #${id}: ${status.outcome}`;
            if (status.question) {
              const asked = status.question;
              return [
                `Report #${id} is not settled: the session that looks into it asked you a question and waits for the answer.`,
                "",
                `Question #${asked.id}: ${asked.question}`,
                ...(asked.options.length > 0
                  ? [`Suggested answers: ${asked.options.join(" | ")}`]
                  : []),
                "",
                `Give the answer with the "answer" tool (question_id: ${asked.id}), then call report_gap again with report_id ${id} and blocking to keep waiting. The same question may still reach you as a message; it needs no second answer.`,
              ].join("\n");
            }
            await Bun.sleep(RETRY_MS);
          }
          await api("POST", "/selfheal/status", { id, from: agentId, waiting: false }).catch(
            () => undefined,
          );
          return `Stopped waiting for report #${id}. Its outcome will reach you as a message.`;
        }),
    );
  }

  if (options.selfheal) {
    server.registerTool(
      "selfheal_context",
      {
        description:
          "Everything about the reports you were started for: who reported what, what each session was started with and would get now and from which file each value comes, the calls that did not run, the role's files, the defaults, what the config offers, and what the user turned down before. Call it first, and again when you are told a report joined.",
      },
      () =>
        tool(async () => {
          const context = await api<{ text: string }>("POST", "/selfheal/context", {
            from: agentId,
          });
          return context.text;
        }),
    );

    server.registerTool(
      "propose_fix",
      {
        description:
          "Hand in the change that closes the gap. You write nothing yourself: the change is checked as a start of a session would check it, then shown to the user, who applies it to the role, gives it to the reporting sessions alone, or turns it down. You get a message with the decision; end your turn after this call. A new proposal replaces the one that waits. Each change is one item added to or removed from a list, or one value set or unset, so the user can switch single ones off: propose the least that closes the gap.",
        inputSchema: {
          summary: z.string().describe("One line: what changes, for whom."),
          reason: z
            .string()
            .describe(
              "Why this closes the gap, what it lets the role do that it could not before, and any doubt the user should weigh.",
            ),
          changes: z
            .array(
              z.object({
                file: z
                  .string()
                  .optional()
                  .describe(
                    "role:<name>, personal-role:<name>, defaults or personal-defaults. Without it: the role under repair. Use the file the value comes from now (selfheal_context says which).",
                  ),
                key: z
                  .string()
                  .optional()
                  .describe(
                    "A list: tools, deny_tools, allow, deny, mcp, plugins, skills, off_mcp, off_plugins, off_skills, builtin_skills. Or one value: model, effort, permission_mode, memory, subagents, prompt, description, when_to_use. With table: a key of that table's entry.",
                  ),
                add: z.string().optional().describe("An item to add to a list."),
                remove: z.string().optional().describe("An item to take out of a list."),
                set: z
                  .union([
                    z.string(),
                    z.boolean(),
                    z.number(),
                    z.array(z.string()),
                    z.record(z.string(), z.string()),
                  ])
                  .optional()
                  .describe(
                    "The new value; for prompt the whole new text. With table: the key's whole new value (a text, a list of texts, or for env and headers a record of texts).",
                  ),
                unset: z.boolean().optional().describe("Take the key out of the file."),
                table: z
                  .string()
                  .optional()
                  .describe(
                    "For a change to the config itself instead of a role: mcp, plugins, profiles, agents or main. The file is then config (the default) or personal-config.",
                  ),
                name: z
                  .string()
                  .optional()
                  .describe("With table: the entry, such as the server's name. Not for main."),
                body: z
                  .record(
                    z.string(),
                    z.union([
                      z.string(),
                      z.boolean(),
                      z.number(),
                      z.array(z.string()),
                      z.record(z.string(), z.string()),
                    ]),
                  )
                  .optional()
                  .describe(
                    "With table and name: the keys of a new entry, such as { command, args } for an MCP server. A role that should use it needs the name in its mcp or plugins list as a change of its own.",
                  ),
                remove_table: z
                  .boolean()
                  .optional()
                  .describe("With table and name: take the whole entry out."),
                why: z.string().optional().describe("What this one change is for."),
              }),
            )
            .min(1),
        },
      },
      ({ summary, reason, changes }) =>
        tool(async () => {
          const made = await api<{ id: number; lines: string[] }>("POST", "/selfheal/propose", {
            from: agentId,
            summary,
            reason,
            changes,
          });
          return `Fix #${made.id} waits for the user's decision:\n${made.lines.map((line) => `- ${line}`).join("\n")}\nEnd your turn now. The reporters are told the outcome by ${APP_NAME}; you get a message if the fix has to be reworked.`;
        }),
    );

    server.registerTool(
      "answer_report",
      {
        description:
          "Settle reports without a change: the reporter can do what it needs with what it has (say exactly how), the user turned the same thing down before (give their reason), or it should not have it. The reporter gets your text as the outcome.",
        inputSchema: {
          answer: z.string(),
          reports: z
            .array(z.number().int())
            .optional()
            .describe("The report numbers this settles. Without it: every open report."),
        },
      },
      ({ answer, reports }) =>
        tool(async () => {
          const done = await api<{ settled: number[] }>("POST", "/selfheal/answer", {
            from: agentId,
            answer,
            reports,
          });
          return `Settled report ${done.settled.map((id) => `#${id}`).join(", ")}.`;
        }),
    );

    server.registerTool(
      "file_bug",
      {
        description: `Settle the open reports as a defect in ${APP_NAME} itself: it did not do what its role files and config say, and no change to them would mend it. Writes a report for the user into the project's .${APP_NAME}/reports folder and tells the reporters.`,
        inputSchema: {
          title: z.string().describe("One line that names the defect."),
          what: z.string().describe("What happened, with the exact texts and names."),
          steps: z.string().describe("How to make it happen again."),
          expected: z.string().optional().describe("What should have happened."),
        },
      },
      ({ title, what, steps, expected }) =>
        tool(async () => {
          const filed = await api<{ path: string }>("POST", "/selfheal/bug", {
            from: agentId,
            title,
            what,
            steps,
            expected,
          });
          return `Report written to ${filed.path}. The reporters and the user are told.`;
        }),
    );
  }

  if (options.leader) {
    server.registerTool(
      "restart_agent",
      {
        description:
          "Start another agent's session again with its conversation kept: for an agent that is stuck, or one list_agents shows as behind its role's files. Not for the main session or yourself.",
        inputSchema: {
          name: z.string(),
          when: z
            .enum(["now", "turn-end"])
            .optional()
            .describe(
              "turn-end waits until the agent has finished what it is doing; the default is now.",
            ),
        },
      },
      ({ name, when }) =>
        tool(async () => {
          const { applied } = await api<{ applied: string }>("POST", "/agents/restart", {
            target: name,
            when: when ?? "now",
            from: agentId,
          });
          return applied === "pending"
            ? `"${name}" restarts when its turn ends.`
            : `Restarted "${name}".`;
        }),
    );

    server.registerTool(
      "cancel_workflow",
      {
        description:
          "Stop a workflow run in progress. Its running steps' agents are stopped and no further step starts; what finished steps produced stays readable with workflow_status.",
        inputSchema: { run_id: z.number().int() },
      },
      ({ run_id }) =>
        tool(async () =>
          describeRun(
            await api<WorkflowRunInfo>("POST", "/workflows/cancel", { id: run_id }),
            true,
          ),
        ),
    );
  }

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
          access?: string[];
        }>("POST", "/workflows/save", { from: agentId, name, definition, personal });
        const done = `${saved.created ? "Created" : "Saved"} workflow "${saved.name}" (v${saved.version}) at ${saved.path}\nSteps: ${saved.steps.join(" -> ")}`;
        if (!saved.access?.length) return done;
        return [
          done,
          "",
          "These steps never ask for permission: a shell command that is not listed is refused and the step fails there.",
          ...saved.access,
          "Compare each with what its prompt asks for. Where a command is missing, give the step its own `allow` (and `deny`), which replace the role's lists, or use another role, and save again.",
        ].join("\n");
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

  const server = createMcpServer(agentId, api, {
    leader: env.DWA_LEADER === "1",
    selfheal: env.DWA_SELFHEAL === "1",
    noReport: env.DWA_NO_REPORT === "1",
  });
  reportReady(server, agentId, api);
  await server.connect(new StdioServerTransport());
}

/**
 * Tells the daemon when the session has connected to this server. Only from then on can a
 * prompt reach the session with the dwa tools in it, so the daemon holds the task until this.
 */
export function reportReady(server: McpServer, agentId: string, api: Api): void {
  server.server.oninitialized = () => {
    api("POST", "/agents/ready", { agentId }).catch(() => undefined);
  };
}
