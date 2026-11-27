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
import { ago } from "./model.ts";
import { OFF, ON, type Outcome, type Row, type Screen, type Values } from "./wizard.ts";
import type { WizardApi } from "./wizards.ts";

const back: Row = { kind: "button", label: "Back", run: () => ({ back: true }) };
const close: Row = { kind: "button", label: "Close", run: () => ({ close: true }) };

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

/** The ids of the changes whose switch is off. */
function droppedIn(view: FixView, values: Values): string[] {
  return view.lines.filter((line) => values[line.id] === OFF).map((line) => line.id);
}

/**
 * The rows that show what a fix changes: a switch for each change, then each file as it would
 * differ with the changes that are on. `changed` is what a switch does once it has changed.
 */
export function changeRows(
  view: FixView,
  changed?: (values: Values) => Outcome | Promise<Outcome>,
): Row[] {
  const rows: Row[] = [{ kind: "heading", text: "CHANGES" }];
  for (const line of view.lines) {
    rows.push({
      kind: "check",
      key: line.id,
      label: `${line.widens ? "▲ " : ""}${line.file}: ${line.text}`,
      ...(changed ? { changed } : {}),
    });
    const tone = line.warning ? "bad" : line.widens ? "attention" : "muted";
    const under = [
      ...(line.warning ? [`far-reaching: ${line.warning}`] : []),
      ...(line.why ? [line.why] : []),
    ];
    if (under.length > 0) {
      rows.push({ kind: "note", tone, text: under.map((text) => `      ${text}`).join("\n") });
    }
    if (line.detail) {
      rows.push({ kind: "note", text: line.detail.map((text) => `      ${text}`).join("\n") });
    }
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
    rows.push(
      {
        kind: "note",
        text: file.diff.length > 0 ? file.diff.join("\n") : "The file already says so.",
      },
      {
        kind: "button",
        label: "Whole file before",
        hint: "›",
        run: () => ({ to: textScreen(`${file.label}, as it is`, file.before) }),
      },
      {
        kind: "button",
        label: "Whole file after",
        hint: "›",
        run: () => ({ to: textScreen(`${file.label}, with the fix`, file.after) }),
      },
    );
  }
  return rows;
}

function textScreen(title: string, text: string): Screen {
  return { title, rows: [{ kind: "note", text: text.trimEnd() || "(empty)" }, back] };
}

/**
 * One proposed fix with everything needed to decide on it. `dropped` are the changes switched
 * off: the files are shown, and the fix is applied, without them.
 */
export async function fixScreen(
  api: WizardApi,
  id: number,
  dropped: string[] = [],
): Promise<Screen> {
  const view = await api.call<FixView>(
    "GET",
    `/selfheal/proposal?id=${id}${dropped.length > 0 ? `&drop=${encodeURIComponent(dropped.join(","))}` : ""}`,
  );
  const title = `Fix #${view.id} for ${about(view.role)}`;
  const decide = async (decision: Omit<FixDecision, "id" | "base">): Promise<Outcome> => {
    const result = await api.call<FixResult>("POST", "/selfheal/decide", {
      ...decision,
      id: view.id,
      base: view.base,
    });
    return { home: resultScreen(api, title, result) };
  };
  // A switch redraws the screen from the daemon's answer for the changes that are still on.
  const redraw = async (values: Values): Promise<Outcome> => ({
    replace: await fixScreen(api, id, droppedIn(view, values)),
  });
  const rows: Row[] = [
    { kind: "note", text: view.summary },
    { kind: "note", text: view.reason },
    { kind: "note", text: "" },
    { kind: "heading", text: "REPORTED BY" },
    ...view.reports.map(
      (report): Row => ({
        kind: "note",
        text: `${report.reporter}${report.gone ? " (ended)" : ""}: ${report.what}${report.tried ? `\n  tried: ${report.tried}` : ""}`,
      }),
    ),
    { kind: "note", text: "" },
    ...changeRows(view, redraw),
    { kind: "note", text: "" },
  ];
  const values: Values = Object.fromEntries(
    view.lines.map((line) => [line.id, line.on ? ON : OFF]),
  );
  const refuse: Row = {
    kind: "button",
    label: "Turn down…",
    tone: "bad",
    run: () => ({ to: refuseScreen(view, decide) }),
  };
  if (view.error || view.empty) {
    rows.push(
      {
        kind: "note",
        tone: view.error ? "bad" : "attention",
        text: view.error
          ? `This no longer fits the files as they are, so it cannot be applied:\n${view.error}`
          : "Every change is switched off, so there is nothing to apply.",
      },
      refuse,
      back,
    );
    return { title, rows, values };
  }
  const sessions = view.sessions.join(", ");
  const restart = (form: Values) => (form.restart === LATER ? "later" : "turn-end");
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
  const off = view.lines.filter((line) => !line.on).length;
  rows.push({
    kind: "button",
    label: off > 0 ? `Apply to the role, without the ${off} switched off` : "Apply to the role",
    hint: sessions
      ? `every later session of it; ${sessions} restarts with its conversation`
      : "every later session of it",
    tone: "good",
    run: (form) =>
      decide({ action: "role", restart: restart(form), dropped: droppedIn(view, form) }),
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
      run: (form) =>
        decide({ action: "session", restart: restart(form), dropped: droppedIn(view, form) }),
    });
  }
  rows.push(refuse, back);
  return { title, rows, values };
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
      { kind: "note", text: result.message },
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
