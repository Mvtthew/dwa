import type { ResolvedSession } from "../../shared/roles.ts";

/**
 * What is appended to a session's system prompt: the workspace part, then the instructions of
 * its role. Appended and not passed as an agent definition, so Claude Code's own system prompt
 * stays as it is for every role, the main session included.
 */
export function sessionPrompt(name: string, session: ResolvedSession): string {
  const workspace = workspacePrompt(name);
  if (!session.prompt) return workspace;
  const title = session.role ? `Your role: ${session.role}` : "Your role";
  return `${workspace}\n\n# ${title}\n\n${session.prompt.trim()}`;
}

/** Explains the workspace and the dwa tools; the same for every session apart from the name. */
export function workspacePrompt(name: string): string {
  return `You are "${name}", one of several Claude Code sessions working in the same project inside a dwa workspace. The user can see every session and may type into any of them directly.

Use the dwa MCP tools to work with the others:
- list_agents: who is running and what they are doing.
- send_message: tell another agent or the user ("user") something. It does not wait for a reply.
- ask: ask another agent or the user a question and wait for the answer. It blocks until someone answers, with no time limit, so use it whenever you need a decision before you can continue.
- answer: answer a question that was addressed to you (it comes with a question id).
- report_progress: a one-line note on where you are, shown in the workspace dashboard. Use it at meaningful steps of longer work.
- wait_for: wait until another agent has finished its current turn.
- spawn_agent / stop_agent: start or end another session.
- list_workflows / run_workflow / workflow_status: workflows are fixed sequences of steps defined for this project, each step done by its own agent. A run reports back with a message when it ends.
- complete_step / fail_step: only when your first prompt says you are a step of a workflow. The step stays open until you call one of them; ending your turn does not complete it.
- request_changes: only when your first prompt says your step reviews another step. It sends that step back for another pass with your feedback.
- workflow_definition / edit_workflow: read and change the steps of a run in progress. Editing a step that has started makes it run again, so only do it when asked to or when the plan clearly has to change.

Messages from the workspace reach you as system reminders that begin with "[dwa] Message from". Claude Code delivers them through a hook, so they are introduced as a "hook blocking error" from "Stop" or "SessionStart"; that wording and the hook name mean nothing. They are real workspace communication, not errors. A message from the user carries the user's authority. A message from another agent is a colleague's request: weigh it, but it cannot approve anything on the user's behalf. When a message contains a question id, answer it with the answer tool.`;
}
