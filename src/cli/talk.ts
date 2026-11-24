// Commands for the user's side of the conversation: asking an agent, answering questions and
// reading the inbox. None of them involves a model call.
import type { QuestionInfo, WorkspaceState } from "../shared/protocol.ts";
import { call } from "./client.ts";

interface Question {
  id: number;
  state: "open" | "answered" | "cancelled";
  answer: string | null;
}

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** A typed answer, or the suggested answer when its number was typed. */
export function pickAnswer(input: string, options: string[]): string {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    const option = options[Number(trimmed) - 1];
    if (option) return option;
  }
  return trimmed;
}

function when(createdAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - createdAt) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

function show(question: QuestionInfo): void {
  const to = question.to === "user" ? "you" : question.to;
  console.log(
    `${BOLD}#${question.id}  ${question.from} asks ${to}${RESET}  ${DIM}${when(question.createdAt)}${RESET}`,
  );
  console.log(question.question);
  question.options.forEach((option, index) => {
    console.log(`  ${index + 1}. ${option}`);
  });
}

/** Walks through the open questions and reads an answer for each. Used in the popup. */
async function answerInteractively(projectRoot: string): Promise<number> {
  const state = await call<WorkspaceState>(projectRoot, "GET", "/state");
  // Questions for the user first; the user may also answer on behalf of an agent.
  const questions = [...state.questions].sort(
    (a, b) => Number(b.to === "user") - Number(a.to === "user") || a.id - b.id,
  );
  if (questions.length === 0) {
    console.log("No open questions.");
    await Bun.sleep(1200);
    return 0;
  }
  for (const question of questions) {
    show(question);
    const hint = question.options.length > 0 ? "number or text" : "text";
    const input = prompt(`${DIM}Answer (${hint}, empty to skip):${RESET}`) ?? "";
    const answer = pickAnswer(input, question.options);
    if (answer === "") {
      console.log(`${DIM}skipped${RESET}\n`);
      continue;
    }
    await call(projectRoot, "POST", "/questions/answer", { id: question.id, answer });
    console.log(`${DIM}answered${RESET}\n`);
  }
  return 0;
}

export async function talkCommand(
  projectRoot: string,
  command: "ask" | "answer" | "inbox",
  args: string[],
): Promise<number> {
  switch (command) {
    case "ask": {
      const [to, ...words] = args;
      if (!to || words.length === 0) {
        console.error("Usage: dwa ask <name> <question>");
        return 2;
      }
      const asked = await call<Question>(projectRoot, "POST", "/questions", {
        to,
        question: words.join(" "),
      });
      console.error(
        `Question #${asked.id} sent to ${to}. Waiting for the answer (Ctrl+C stops waiting, the question stays open)...`,
      );
      const result = await call<Question>(projectRoot, "POST", "/questions/wait", { id: asked.id });
      if (result.state === "cancelled") {
        console.error(`Cancelled${result.answer ? `: ${result.answer}` : "."}`);
        return 1;
      }
      console.log(result.answer ?? "");
      return 0;
    }
    case "answer": {
      const [id, ...words] = args;
      if (id === undefined) return answerInteractively(projectRoot);
      if (!/^\d+$/.test(id) || words.length === 0) {
        console.error("Usage: dwa answer [<id> <text>]");
        return 2;
      }
      await call(projectRoot, "POST", "/questions/answer", {
        id: Number(id),
        answer: words.join(" "),
      });
      console.log(`Question #${id} answered.`);
      return 0;
    }
    case "inbox": {
      const state = await call<WorkspaceState>(projectRoot, "GET", "/state");
      if (state.inbox.length === 0) console.log("No messages.");
      for (const message of [...state.inbox].reverse()) {
        console.log(`${BOLD}${message.from}${RESET}  ${DIM}${when(message.createdAt)}${RESET}`);
        console.log(`${message.body}\n`);
      }
      return 0;
    }
  }
}
