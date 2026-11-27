// The screens of proposed fixes: what a selfheal session wants changed after a session reported
// a gap in its setup, for the user to apply or turn down, and the form to report one oneself.
// Screens as data; nothing here draws.
import { APP_NAME } from "../shared/constants.ts";
import type {
  FixDecision,
  FixMemory,
  FixResult,
  FixSummary,
  FixView,
  WorkspaceState,
} from "../shared/protocol.ts";
import { ago, wrapAll } from "./model.ts";
import type { Outcome, Row, Screen, Values } from "./wizard.ts";
import type { WizardApi } from "./wizards.ts";

const back: Row = { kind: "button", label: "Back", run: () => ({ back: true }) };
const close: Row = { kind: "button", label: "Close", run: () => ({ close: true }) };

/** A popup's notes are not wrapped by the form, so prose is wrapped here, to its narrowest size. */
const WIDTH = 76;
const prose = (text: string) => wrapAll(text, WIDTH).join("\n");

/** The value of the choice that says when the main session restarts. */
const LATER = "later";

function about(role: string): string {
  return role ? `role ${role}` : "sessions without a role";
}

/** The fixes that wait, the fixes turned down before, and reporting a problem oneself. */
export async function fixesScreen(api: WizardApi, now = Date.now()): Promise<Screen> {
  const [{ proposals }, { memory }] = await Promise.all([
    api.call<{ proposals: FixSummary[] }>("GET", "/selfheal/proposals"),
    api.call<{ memory: FixMemory[] }>("GET", "/selfheal/memory"),
  ]);
  const rows: Row[] = [];
  if (proposals.length === 0) {
    rows.push({ kind: "note", text: "No fix waits for your decision." });
  }
  for (const proposal of proposals) {
    rows.push({
      kind: "button",
      label: `#${proposal.id}  ${about(proposal.role)}: ${proposal.summary}`,
      hint: `${proposal.reporters.join(", ")} · ${ago(proposal.createdAt, now)} ›`,
      tone: "attention",
      run: async () => ({ to: await fixScreen(api, proposal.id) }),
    });
  }
  rows.push(
    { kind: "note", text: "" },
    {
      kind: "button",
      label: "Report a problem…",
      hint: "a session or a role that lacks something",
      run: async () => ({ to: await reportScreen(api) }),
    },
  );
  if (memory.length > 0) {
    rows.push({
      kind: "button",
      label: `Turned down before (${memory.length})…`,
      hint: "not proposed again while they are kept",
      run: () => ({ to: memoryScreen(api, memory, now) }),
    });
  }
  rows.push(close);
  return { title: "Proposed fixes", rows };
}

/** The rows that show what a fix changes: each change, then each file as it would differ. */
export function changeRows(view: FixView): Row[] {
  const rows: Row[] = [{ kind: "heading", text: "CHANGES" }];
  for (const line of view.lines) {
    rows.push({
      kind: "note",
      tone: line.warning ? "bad" : line.widens ? "attention" : undefined,
      text: [
        `${line.widens ? "▲" : "·"} ${line.file}: ${line.text}`,
        ...(line.warning ? [`  far-reaching: ${line.warning}`] : []),
        ...(line.why ? [prose(`  ${line.why}`)] : []),
      ].join("\n"),
    });
  }
  if (view.lines.some((line) => line.widens)) {
    rows.push({ kind: "note", tone: "muted", text: "▲ gives a session more than it had" });
  }
  for (const file of view.files) {
    rows.push({ kind: "note", text: "" }, { kind: "heading", text: file.path });
    if (file.adopt) {
      rows.push({
        kind: "note",
        tone: "attention",
        text: `This role is built into ${APP_NAME}. Applying copies it into the project first; from then on\nthe file is the role here and no longer follows ${APP_NAME}'s own updates.`,
      });
    }
    rows.push({
      kind: "note",
      text: file.diff.length > 0 ? file.diff.join("\n") : "The file already says so.",
    });
  }
  return rows;
}

/** One proposed fix with everything needed to decide on it. */
export async function fixScreen(api: WizardApi, id: number): Promise<Screen> {
  const view = await api.call<FixView>("GET", `/selfheal/proposal?id=${id}`);
  const title = `Fix #${view.id} for ${about(view.role)}`;
  const decide = async (decision: Omit<FixDecision, "id" | "base">): Promise<Outcome> => {
    const result = await api.call<FixResult>("POST", "/selfheal/decide", {
      ...decision,
      id: view.id,
      base: view.base,
    });
    return { home: resultScreen(api, title, result) };
  };
  const rows: Row[] = [
    { kind: "note", text: prose(view.summary) },
    { kind: "note", text: prose(view.reason) },
    { kind: "note", text: "" },
    { kind: "heading", text: "REPORTED BY" },
    ...view.reports.map(
      (report): Row => ({
        kind: "note",
        text: prose(
          `${report.reporter}${report.gone ? " (ended)" : ""}: ${report.what}${report.tried ? `\n  tried: ${report.tried}` : ""}`,
        ),
      }),
    ),
    { kind: "note", text: "" },
    ...changeRows(view),
    { kind: "note", text: "" },
  ];
  const refuse: Row = {
    kind: "button",
    label: "Turn down…",
    tone: "bad",
    run: () => ({ to: refuseScreen(view, decide) }),
  };
  if (view.error) {
    rows.push(
      {
        kind: "note",
        tone: "bad",
        text: `This no longer fits the files as they are, so it cannot be applied:\n${view.error}`,
      },
      refuse,
      back,
    );
    return { title, rows };
  }
  const sessions = view.sessions.join(", ");
  const restart = (values: Values) => (values.restart === LATER ? "later" : "turn-end");
  if (view.main) {
    rows.push({
      kind: "choice",
      key: "restart",
      label: "Main session",
      options: [
        { value: "turn-end", label: "restart it when its turn ends" },
        { value: LATER, label: "I restart it later" },
      ],
    });
  }
  rows.push({
    kind: "button",
    label: "Apply to the role",
    hint: sessions
      ? `every later session of it; ${sessions} restarts with its conversation`
      : "every later session of it",
    tone: "good",
    run: (values) => decide({ action: "role", restart: restart(values) }),
  });
  if (view.noSessionOnly) {
    rows.push({
      kind: "note",
      tone: "muted",
      text: `Not for one session alone: ${view.noSessionOnly}.`,
    });
  } else {
    rows.push({
      kind: "button",
      label: `Only for ${sessions}`,
      hint: "no file changes; gone when the session ends",
      run: (values) => decide({ action: "session", restart: restart(values) }),
    });
  }
  rows.push(refuse, back);
  return { title, rows, values: { restart: "turn-end" } };
}

function refuseScreen(
  view: FixView,
  decide: (decision: Omit<FixDecision, "id" | "base">) => Promise<Outcome>,
): Screen {
  return {
    title: `Turn down fix #${view.id}`,
    rows: [
      {
        kind: "note",
        text: `The reporter is told your reason and carries on without the change. ${APP_NAME} remembers it\nfor ${about(view.role)}, so the same fix is not proposed to you again.`,
      },
      { kind: "input", key: "reason", label: "Reason", placeholder: "why not" },
      {
        kind: "button",
        label: "Turn down",
        tone: "bad",
        run: (values) => decide({ action: "refuse", reason: values.reason }),
      },
      back,
    ],
  };
}

function resultScreen(api: WizardApi, title: string, result: FixResult): Screen {
  return {
    title,
    rows: [
      { kind: "note", text: prose(result.message) },
      {
        kind: "button",
        label: "Other fixes",
        run: async () => ({ home: await fixesScreen(api) }),
      },
      close,
    ],
  };
}

function memoryScreen(api: WizardApi, memory: FixMemory[], now: number): Screen {
  return {
    title: "Turned down before",
    rows: [
      ...memory.map(
        (item): Row => ({
          kind: "note",
          text: `${about(item.role)}: ${item.summary}  (${ago(item.createdAt, now)})\n  your reason: ${item.reason}`,
        }),
      ),
      { kind: "note", text: "" },
      {
        kind: "button",
        label: "Forget all of them",
        hint: "they can be proposed again; nothing is deleted",
        run: async () => {
          await api.call("POST", "/selfheal/memory/clear", {});
          return { home: await fixesScreen(api) };
        },
      },
      back,
    ],
  };
}

/** Reporting a problem as the user: about a running session, or about a role nobody runs. */
export async function reportScreen(api: WizardApi): Promise<Screen> {
  const state = await api.call<WorkspaceState>("GET", "/state");
  const sessions = [...(state.main ? [state.main] : []), ...state.agents];
  const options = [
    ...sessions.map((agent) => ({
      value: agent.name,
      label: `${agent.name}${agent.role ? ` (role ${agent.role})` : ""}`,
    })),
    ...api.roles
      .filter((role) => !sessions.some((agent) => agent.name === role))
      .map((role) => ({ value: role, label: `role ${role}` })),
  ];
  if (options.length === 0) {
    return {
      title: "Report a problem",
      rows: [{ kind: "note", text: "There is no session and no role to report on." }, back],
    };
  }
  return {
    title: "Report a problem",
    rows: [
      {
        kind: "note",
        text: "A session made for this looks into it and proposes a change to the role, which you\nthen apply or turn down here.",
      },
      { kind: "choice", key: "target", label: "About", options },
      { kind: "text", key: "what", label: "What is wrong", height: 5 },
      {
        kind: "button",
        label: "Report",
        tone: "good",
        run: async (values) => {
          const receipt = await api.call<{ id: number; selfheal: string }>(
            "POST",
            "/selfheal/reports",
            { target: values.target, what: values.what },
          );
          return {
            to: {
              title: "Reported",
              rows: [
                {
                  kind: "note",
                  text: `Report #${receipt.id} is with ${receipt.selfheal}. Its fix shows up in the top bar (✚) when it is ready.`,
                },
                close,
              ],
            },
          };
        },
      },
      back,
    ],
  };
}
