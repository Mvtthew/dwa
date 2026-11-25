import { ConfigError } from "../shared/config.ts";
import type {
  HookRequest,
  SpawnRequest,
  StatuslineRequest,
  UpRequest,
} from "../shared/protocol.ts";
import {
  POPUP_KINDS,
  type RefreshRequest,
  type RestartWhen,
  type ToolsSaveRequest,
} from "../shared/protocol.ts";
import { listWorkflows } from "../shared/workflow.ts";
import { noticeWorkflowEdits } from "../shared/workflow-edit.ts";
import { TmuxError } from "../tmux/driver.ts";
import type { Delegation } from "./delegation.ts";
import { USER } from "./messaging.ts";
import type { RoleAuthor } from "./role-author.ts";
import type { Workflows } from "./workflows.ts";
import { type Workspace, WorkspaceError } from "./workspace.ts";

export interface ServerOptions {
  socketPath: string;
  workspace: Workspace;
  workflows: Workflows;
  delegation: Delegation;
  roleAuthor: RoleAuthor;
  /** Called after `/down` has answered, to stop the daemon process. */
  onShutdown: () => void;
}

interface StepRequest {
  agentId?: string;
  id?: unknown;
  step?: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function body<T>(request: Request): Promise<T> {
  const text = await request.text();
  return (text ? JSON.parse(text) : {}) as T;
}

function requireTarget(input: { target?: unknown }): string {
  if (typeof input.target !== "string" || input.target === "") {
    throw new WorkspaceError("Missing agent name or number.");
  }
  return input.target;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new WorkspaceError(`Missing "${field}".`);
  return value;
}

/** Who a request acts as: an agent id, or the user when none is given (the CLI and the panes). */
function sender(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : USER;
}

/** The daemon's local API on a Unix socket. The CLI and the UI panes are its clients. */
export function startServer(options: ServerOptions) {
  const { workspace, workflows, delegation, roleAuthor } = options;
  const { messaging } = workspace;

  const route = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const key = `${request.method} ${pathname}`;
    switch (key) {
      case "GET /ping":
        return json({ ok: true, pid: process.pid });
      case "GET /state":
        return json(await workspace.state());
      case "POST /up":
        return json(await workspace.up(await body<UpRequest>(request)));
      case "POST /agents":
        return json(await workspace.spawn(await body<SpawnRequest>(request)));
      case "POST /roles/list": {
        const input = await body<{ from?: string }>(request);
        return json({ roles: workspace.roleList(input.from) });
      }
      case "POST /agents/open":
        return json(await workspace.open(requireTarget(await body(request))));
      case "POST /agents/toggle":
        return json(await workspace.toggle(requireTarget(await body(request))));
      case "POST /shell/toggle":
        return json(await workspace.toggleShell());
      case "POST /popup": {
        const { kind, subject } = await body<{ kind?: unknown; subject?: unknown }>(request);
        const known = POPUP_KINDS.find((entry) => entry === kind);
        if (!known) throw new WorkspaceError(`Unknown popup: use ${POPUP_KINDS.join(", ")}.`);
        // The subject becomes a word of a command line, so only a plain name or id passes,
        // with the colon of "personal:<name>" and "run:<id>".
        const about =
          typeof subject === "string" && /^[\w.:-]{1,64}$/.test(subject) ? subject : undefined;
        workspace.popup(known, about);
        return json({ ok: true });
      }
      case "POST /zoom":
        await workspace.zoomMain();
        return json({ ok: true });
      case "POST /detach":
        await workspace.detach();
        return json({ ok: true });
      case "POST /agents/close":
        await workspace.close();
        return json({ ok: true });
      case "GET /tools":
        return json(
          await workspace.toolsInfo(new URL(request.url).searchParams.get("target") ?? ""),
        );
      case "POST /tools":
        return json(await workspace.saveTools(await body<ToolsSaveRequest>(request)));
      case "POST /agents/refresh":
        return json(await workspace.refresh(await body<RefreshRequest>(request)));
      case "POST /agents/restart": {
        const input = await body<{ target?: string; when?: RestartWhen }>(request);
        return json({ applied: await workspace.restart(requireTarget(input), input.when) });
      }
      case "POST /agents/stop": {
        const input = await body<{ target?: unknown; from?: string }>(request);
        const target = requireTarget(input);
        try {
          delegation.expectStop(messaging.resolve(target), sender(input.from));
        } catch {
          // Not a running agent's name or id; stopping it says what is wrong.
        }
        return json(await workspace.stop(target));
      }
      case "POST /agents/outcome": {
        const input = await body<{ target?: unknown; from?: string }>(request);
        return json({ message: delegation.outcome(requireTarget(input), sender(input.from)) });
      }
      case "POST /agents/finish": {
        const input = await body<{ agentId?: string; result?: string }>(request);
        return json({
          message: await delegation.finish(text(input.agentId, "agentId"), input.result ?? ""),
        });
      }
      case "POST /focus":
        await workspace.focusMain();
        return json({ ok: true });
      case "POST /hook":
        return json({ ok: true, ...workspace.hook(await body<HookRequest>(request)) });
      case "POST /statusline":
        workspace.statusline(await body<StatuslineRequest>(request));
        return json({ ok: true });
      case "POST /messages": {
        const input = await body<{ from?: string; to?: string; body?: string }>(request);
        return json(messaging.send(sender(input.from), text(input.to, "to"), input.body ?? ""));
      }
      case "POST /questions": {
        const input = await body<{
          from?: string;
          to?: string;
          question?: string;
          options?: unknown;
        }>(request);
        const options = Array.isArray(input.options)
          ? input.options.filter((option): option is string => typeof option === "string")
          : null;
        return json(
          messaging.ask(sender(input.from), text(input.to, "to"), input.question ?? "", options),
        );
      }
      case "POST /questions/wait": {
        // Held open until the question is answered or cancelled. There is no timeout.
        const input = await body<{ id?: unknown }>(request);
        return json(await messaging.waitQuestion(Number(input.id), request.signal));
      }
      case "POST /questions/answer": {
        const input = await body<{ id?: unknown; by?: string; answer?: string }>(request);
        return json(messaging.answer(Number(input.id), sender(input.by), input.answer ?? ""));
      }
      case "POST /questions/cancel": {
        const input = await body<{ id?: unknown; by?: string }>(request);
        return json(messaging.cancel(Number(input.id), sender(input.by)));
      }
      case "POST /mailbox/wait": {
        const input = await body<{ agentId?: string }>(request);
        return json({
          messages: await messaging.waitMailbox(text(input.agentId, "agentId"), request.signal),
        });
      }
      case "POST /progress": {
        const input = await body<{ agentId?: string; summary?: string; percent?: number }>(request);
        workspace.progress(text(input.agentId, "agentId"), input.summary ?? "", input.percent);
        return json({ ok: true });
      }
      case "GET /workflows":
        // A file changed in an editor since the last look gets its version first.
        noticeWorkflowEdits({ projectRoot: workspace.projectRoot });
        return json({
          workflows: listWorkflows(workspace.projectRoot),
          runs: workflows.runs(),
        });
      case "POST /workflows/run": {
        const input = await body<{ from?: string; name?: string; input?: string }>(request);
        return json(
          await workflows.start(text(input.name, "name"), input.input ?? "", sender(input.from)),
        );
      }
      case "POST /workflows/status": {
        const input = await body<{ id?: unknown }>(request);
        return json(workflows.status(Number(input.id)));
      }
      case "POST /workflows/cancel": {
        const input = await body<{ id?: unknown }>(request);
        return json(await workflows.cancel(Number(input.id)));
      }
      case "POST /workflows/definition": {
        const input = await body<{ id?: unknown }>(request);
        return json({ definition: workflows.definition(Number(input.id)) });
      }
      case "POST /workflows/save": {
        const input = await body<{
          name?: string;
          definition?: string;
          from?: string;
          personal?: boolean;
        }>(request);
        return json(
          workflows.saveFile(
            text(input.name, "name"),
            text(input.definition, "definition"),
            sender(input.from),
            input.personal === true,
          ),
        );
      }
      case "POST /workflows/author": {
        const input = await body<{ description?: string; name?: string; personal?: boolean }>(
          request,
        );
        return json(
          await workflows.author(text(input.description, "description"), {
            name: text(input.name, "name"),
            personal: input.personal === true,
          }),
        );
      }
      case "POST /roles/save": {
        const input = await body<{
          name?: string;
          definition?: string;
          from?: string;
          personal?: boolean;
        }>(request);
        return json(
          await roleAuthor.saveFile(
            text(input.name, "name"),
            text(input.definition, "definition"),
            sender(input.from),
            input.personal === true,
          ),
        );
      }
      case "POST /roles/author": {
        const input = await body<{ description?: string; name?: string; personal?: boolean }>(
          request,
        );
        return json(
          await roleAuthor.author(text(input.description, "description"), {
            name: text(input.name, "name"),
            personal: input.personal === true,
          }),
        );
      }
      case "POST /workflows/view": {
        const input = await body<{ id?: unknown }>(request);
        return json(workflows.view(Number(input.id)));
      }
      case "POST /workflows/edit": {
        const input = await body<{
          id?: unknown;
          definition?: string;
          from?: string;
          preview?: boolean;
          base?: string;
        }>(request);
        return json(
          await workflows.edit(
            Number(input.id),
            text(input.definition, "definition"),
            sender(input.from),
            input.preview === true,
            typeof input.base === "string" ? input.base : undefined,
          ),
        );
      }
      case "POST /workflows/step/complete": {
        // An agent closes its own step; the user names the run and the step.
        const input = await body<StepRequest & { result?: string }>(request);
        const result = input.result ?? "";
        return json(
          input.agentId
            ? await workflows.completeStep(input.agentId, result)
            : await workflows.completeStepOf(Number(input.id), text(input.step, "step"), result),
        );
      }
      case "POST /workflows/step/fail": {
        const input = await body<StepRequest & { reason?: string }>(request);
        const reason = input.reason ?? "";
        return json(
          input.agentId
            ? await workflows.failStep(input.agentId, reason)
            : await workflows.failStepOf(Number(input.id), text(input.step, "step"), reason),
        );
      }
      case "POST /workflows/step/decide": {
        const input = await body<{ id?: unknown; step?: string; decision?: string }>(request);
        const run = workflows.decide(
          Number(input.id),
          text(input.step, "step"),
          text(input.decision, "decision"),
        );
        await workflows.settled();
        return json(workflows.status(run.id));
      }
      case "POST /workflows/step/changes": {
        const input = await body<{ agentId?: string; feedback?: string }>(request);
        return json(
          await workflows.requestChanges(text(input.agentId, "agentId"), input.feedback ?? ""),
        );
      }
      case "POST /notify": {
        const { message } = await body<{ message?: unknown }>(request);
        if (typeof message === "string" && message) await workspace.notify(message);
        return json({ ok: true });
      }
      case "POST /down":
        await workspace.down();
        setTimeout(options.onShutdown, 50);
        return json({ ok: true });
      default:
        return json({ error: `Unknown route: ${key}` }, 404);
    }
  };

  return Bun.serve({
    unix: options.socketPath,
    async fetch(request, server) {
      // Waiting for an answer or for mail keeps a request open for as long as it takes.
      server.timeout(request, 0);
      try {
        return await route(request);
      } catch (error) {
        const expected =
          error instanceof WorkspaceError ||
          error instanceof ConfigError ||
          error instanceof TmuxError ||
          error instanceof SyntaxError;
        if (!expected) console.error(error);
        return json({ error: (error as Error).message }, expected ? 400 : 500);
      }
    },
  });
}
