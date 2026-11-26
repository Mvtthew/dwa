// The "Agent tools" dialog: what one session can use, switches to block or allow each thing,
// and the three ways to save a change. Rows and requests only, like the other screens.
import type {
  Applied,
  LeaderInfo,
  LeaderResult,
  RefreshResult,
  RestartWhen,
  SessionRef,
  ToolsInfo,
  ToolsSaveRequest,
  ToolsSaveResult,
  WorkspaceState,
} from "../shared/protocol.ts";
import type { ToolChange } from "../shared/tools.ts";
import { OFF, ON, type Outcome, type Row, type Screen, type Values } from "./wizard.ts";
import type { WizardApi } from "./wizards.ts";

/** What the dialog itself remembers between redraws. */
interface Local {
  /** Rules typed in, not saved yet. */
  rules: { list: "allow" | "deny"; rule: string }[];
  /** Servers whose single tools are shown. */
  expanded: string[];
}

const close: Row = { kind: "button", label: "Close", run: () => ({ close: true }) };
const back: Row = { kind: "button", label: "Back", run: () => ({ back: true }) };

const toolKey = (name: string) => `tool:${name}`;
const serverKey = (name: string) => `server:${name}`;
const serverToolKey = (server: string, name: string) => `st:${server}:${name}`;
const ruleKey = (list: string, rule: string) => `rule:${list}:${rule}`;

const onOff = (on: boolean) => (on ? ON : OFF);

/** The switches as they are before the user touches them, by row key. */
function initialValues(info: ToolsInfo, local: Local): Values {
  const values: Values = {};
  for (const tool of info.view.tools) values[toolKey(tool.name)] = onOff(tool.on);
  for (const server of info.view.servers) {
    values[serverKey(server.name)] = onOff(server.on);
    for (const tool of server.tools ?? []) {
      values[serverToolKey(server.name, tool.name)] = onOff(tool.on);
    }
  }
  for (const rule of info.view.rules) values[ruleKey(rule.list, rule.rule)] = ON;
  // A rule just typed in is not in the session yet: its switch is on, its saved state off.
  for (const rule of local.rules) values[ruleKey(rule.list, rule.rule)] = OFF;
  return values;
}

/** What the user switched, as changes for the daemon. */
export function changesFrom(info: ToolsInfo, local: Local, values: Values): ToolChange[] {
  const initial = initialValues(info, local);
  const changed = (key: string) => values[key] !== undefined && values[key] !== initial[key];
  const changes: ToolChange[] = [];
  for (const tool of info.view.tools) {
    const key = toolKey(tool.name);
    if (changed(key)) changes.push({ kind: "tool", name: tool.name, on: values[key] === ON });
  }
  for (const server of info.view.servers) {
    const key = serverKey(server.name);
    if (changed(key)) changes.push({ kind: "server", name: server.name, on: values[key] === ON });
    for (const tool of server.tools ?? []) {
      const toolAt = serverToolKey(server.name, tool.name);
      if (changed(toolAt)) {
        changes.push({
          kind: "server-tool",
          server: server.name,
          name: tool.name,
          on: values[toolAt] === ON,
        });
      }
    }
  }
  for (const rule of [...info.view.rules, ...local.rules]) {
    const key = ruleKey(rule.list, rule.rule);
    if (changed(key)) changes.push({ kind: "rule", ...rule, on: values[key] === ON });
  }
  return changes;
}

/** Where a section's value comes from, in words. */
function from(origin: string | undefined): string {
  if (!origin) return "";
  if (origin === "defaults") return "from [defaults]";
  if (origin === "personal defaults") return "from your personal [defaults]";
  if (origin === "run") return "saved for this role until the workspace stops";
  if (origin === "session") return "set when this session was started";
  if (origin === "agent") return "changed for this session";
  return `from ${origin}`;
}

const APPLIED: Record<Applied, (name: string) => string> = {
  live: (name) => `${name} has the change now; no restart was needed.`,
  restarted: (name) => `${name} was restarted with its conversation and has the change.`,
  pending: (name) => `${name} restarts with the change when its turn ends.`,
  unchanged: (name) => `Nothing changed for ${name}.`,
  ask: (name) => `${name} was not changed.`,
};

function doneScreen(title: string, lines: string[]): Screen {
  return { title, rows: [{ kind: "note", text: lines.join("\n") }, close] };
}

/** Asks how to restart when the daemon cannot decide alone, then sends the request again. */
function restartScreen(
  agent: SessionRef,
  reason: "working" | "main" | undefined,
  send: (when: RestartWhen) => Promise<Outcome>,
): Screen {
  const main = agent.kind === "main";
  const note = main
    ? "This restarts the main session, the one you talk to. Its conversation is kept and it\ncomes back in the same pane, but whatever it is doing right now is interrupted."
    : `${agent.name} has to be restarted for this. Its conversation is kept.`;
  const rows: Row[] = [{ kind: "note", text: note, tone: main ? "attention" : undefined }];
  if (reason === "working" || agent.activity === "working") {
    rows.push({
      kind: "button",
      label: "Restart when its turn ends",
      tone: "good",
      run: () => send("turn-end"),
    });
  }
  rows.push({ kind: "button", label: "Restart now", run: () => send("now") }, back);
  return { title: `Restart ${agent.name}?`, rows };
}

/** After a save into a file: which of the running sessions should get it now. */
function behindScreen(api: WizardApi, edited: SessionRef, result: ToolsSaveResult): Screen {
  const lines = [result.version ? `Saved (v${result.version}).` : "Saved.", result.note ?? ""];
  if (result.behind.length === 0) {
    return doneScreen("Saved", [...lines, "No running session is affected."].filter(Boolean));
  }
  const rows: Row[] = [
    { kind: "note", text: lines.filter(Boolean).join("\n") },
    { kind: "heading", text: "RUNNING SESSIONS THAT STILL HAVE THE OLD SETUP" },
    ...result.behind.map(
      (session): Row => ({
        kind: "check",
        key: session.id,
        label: session.name,
        hint: [session.role, session.activity.replace("_", " ")].filter(Boolean).join(" · "),
      }),
    ),
    {
      kind: "choice",
      key: "when",
      label: "A session that is working",
      options: [
        { value: "turn-end", label: "restarts when its turn ends" },
        { value: "now", label: "is interrupted" },
      ],
    },
    {
      kind: "button",
      label: "Apply to the ticked sessions",
      tone: "good",
      run: async (values) => {
        const targets = result.behind.filter((session) => values[session.id] === ON);
        if (targets.length === 0) return { close: true };
        const { results } = await api.call<RefreshResult>("POST", "/agents/refresh", {
          targets: targets.map((session) => session.id),
          when: values.when as RestartWhen,
        });
        return {
          to: doneScreen(
            "Applied",
            results.map((entry) => entry.error ?? APPLIED[entry.applied](entry.name)),
          ),
        };
      },
    },
    { kind: "button", label: "Leave them as they are", run: () => ({ close: true }) },
  ];
  return {
    title: "Apply to running sessions?",
    rows,
    values: Object.fromEntries(
      result.behind.map((session) => [session.id, onOff(session.id === edited.id)]),
    ),
  };
}

function build(api: WizardApi, info: ToolsInfo, local: Local): Screen {
  const { agent, view } = info;
  // A redraw keeps the switches as they are: only what it names in `values` changes.
  const redraw = (values: Values = {}): Outcome => ({
    replace: { ...build(api, info, local), values },
  });
  const rows: Row[] = [];
  const state = [agent.role ? `role ${agent.role}` : "no role", agent.activity.replace("_", " ")];
  rows.push({ kind: "note", text: state.join(" · ") });
  if (info.outOfDate) {
    rows.push({
      kind: "note",
      tone: "attention",
      text: "Its role changed since it was started; a restart brings that along too.",
    });
  }

  const toolsOrigin = view.mode === "only" ? view.origins.tools : view.origins.deny_tools;
  rows.push(
    { kind: "heading", text: `BUILT-IN TOOLS  ${from(toolsOrigin)}`.trimEnd() },
    {
      kind: "note",
      text:
        view.mode === "only"
          ? "This session has only the ticked tools."
          : "This session has every tool that is not unticked, new ones included.",
    },
  );
  for (const tool of view.tools) {
    rows.push({
      kind: "check",
      key: toolKey(tool.name),
      label: tool.name,
      fixed: tool.fixed,
    });
  }

  rows.push({ kind: "note", text: "" }, { kind: "heading", text: "MCP SERVERS" });
  for (const server of view.servers) {
    const open = local.expanded.includes(server.name);
    const count = server.tools
      ? `${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`
      : "";
    const place = server.from === "project" ? "from the project" : "";
    const hint = [place, count].filter(Boolean).join(" · ");
    rows.push({
      kind: "check",
      key: serverKey(server.name),
      label: server.name,
      fixed: server.fixed,
      hint: server.tools && !open ? `${hint} ›` : hint,
      more:
        server.tools && !open
          ? () => {
              local.expanded.push(server.name);
              return redraw();
            }
          : undefined,
    });
    if (!open) continue;
    for (const tool of server.tools ?? []) {
      rows.push({
        kind: "check",
        key: serverToolKey(server.name, tool.name),
        label: `   ${tool.name}`,
      });
    }
  }

  const rulesOrigin = [view.origins.allow, view.origins.deny].filter(Boolean)[0];
  rows.push(
    { kind: "note", text: "" },
    { kind: "heading", text: `RULES  ${from(rulesOrigin)}`.trimEnd() },
  );
  for (const rule of [...view.rules, ...local.rules]) {
    rows.push({
      kind: "check",
      key: ruleKey(rule.list, rule.rule),
      label: `${rule.list.padEnd(5)} ${rule.rule}`,
      hint: local.rules.includes(rule as Local["rules"][number]) ? "new" : "",
    });
  }
  rows.push(
    { kind: "input", key: "newRule", label: "Add a rule", placeholder: "Bash(git push *)" },
    {
      kind: "choice",
      key: "newRuleList",
      label: "It is",
      options: [
        { value: "deny", label: "refused" },
        { value: "allow", label: "allowed without asking" },
      ],
    },
    {
      kind: "button",
      label: "Add the rule",
      run: (values) => {
        const rule = values.newRule?.trim() ?? "";
        const list = values.newRuleList === "allow" ? "allow" : "deny";
        if (!rule) throw new Error("Type the rule first, for example Bash(git push *).");
        const known = [...view.rules, ...local.rules];
        if (known.some((entry) => entry.list === list && entry.rule === rule)) {
          throw new Error("That rule is already in the list.");
        }
        local.rules.push({ list, rule });
        return redraw({ newRule: "", [ruleKey(list, rule)]: ON });
      },
    },
  );

  const save =
    (scope: ToolsSaveRequest["scope"], file?: ToolsSaveRequest["file"]) =>
    async (values: Values): Promise<Outcome> => {
      const changes = changesFrom(info, local, values);
      if (changes.length === 0) throw new Error("Nothing was changed.");
      const send = async (when?: RestartWhen): Promise<Outcome> => {
        const request: ToolsSaveRequest = { target: agent.id, changes, scope, file, when };
        const result = await api.call<ToolsSaveResult>("POST", "/tools", request);
        if (scope === "file") return { to: behindScreen(api, agent, result) };
        if (result.applied === "ask") {
          return { to: restartScreen(agent, result.reason, send) };
        }
        return {
          to: doneScreen("Saved", [APPLIED[result.applied](agent.name), result.note ?? ""]),
        };
      };
      return send();
    };

  rows.push(
    { kind: "note", text: "" },
    {
      kind: "note",
      text: "",
      live: (values) => {
        const count = changesFrom(info, local, values).length;
        return count === 0 ? "No changes" : `${count} change${count === 1 ? "" : "s"}`;
      },
    },
    { kind: "button", label: `Save for ${agent.name} only`, tone: "good", run: save("agent") },
  );
  if (agent.role && agent.kind !== "main") {
    rows.push({
      kind: "button",
      label: `Save for ${agent.name} and next ${agent.role} agents`,
      hint: "until the workspace stops",
      tone: "good",
      run: save("run"),
    });
  }
  rows.push(
    {
      kind: "button",
      label: "Save globally…",
      hint: "into a role file or [defaults]",
      tone: "good",
      run: (values) => {
        if (changesFrom(info, local, values).length === 0) throw new Error("Nothing was changed.");
        return {
          to: {
            title: "Save where?",
            rows: [
              {
                kind: "note",
                text: "The change is written into the file; comments and everything else in it stay.\nThe previous version is kept in the history.",
              },
              ...info.files.map(
                (entry): Row => ({
                  kind: "button",
                  label: entry.label,
                  run: () => save("file", entry.file)(values),
                }),
              ),
              back,
            ],
          },
        };
      },
    },
    { kind: "button", label: "Cancel", run: () => ({ close: true }) },
  );
  return { title: `Tools: ${agent.name}`, rows, values: initialValues(info, local) };
}

/** The dialog for one session, by name or id. */
export async function toolsScreen(api: WizardApi, target: string): Promise<Screen> {
  const info = await api.call<ToolsInfo>("GET", `/tools?target=${encodeURIComponent(target)}`);
  return build(api, info, { rules: [], expanded: [] });
}

/** Opened without a session: pick one first. */
export async function toolsPickScreen(api: WizardApi): Promise<Screen> {
  const state = await api.call<WorkspaceState>("GET", "/state");
  const sessions = [...(state.main ? [state.main] : []), ...state.agents];
  return {
    title: "Agent tools",
    rows: [
      { kind: "note", text: "Whose tools?" },
      ...sessions.map(
        (agent): Row => ({
          kind: "button",
          label: agent.name,
          hint: [agent.role, agent.outOfDate ? "role changed since start" : null]
            .filter(Boolean)
            .join(" · "),
          run: async () => ({ to: await toolsScreen(api, agent.id) }),
        }),
      ),
      close,
    ],
  };
}

/**
 * The leader mode switch: what it means, and the restart of the main session that makes it
 * take effect. The setting goes into the personal config.
 */
export async function leaderScreen(api: WizardApi): Promise<Screen> {
  const [info, state] = await Promise.all([
    api.call<LeaderInfo>("GET", "/main/leader"),
    api.call<WorkspaceState>("GET", "/state"),
  ]);
  const title = `Leader mode: ${info.on ? "on" : "off"}`;
  const what = info.on
    ? "The main session leads: it hands work to agents and keeps the conversation with you,\nthe plan and the results. Off, it does the work itself, as an ordinary session."
    : "The main session does the work itself. On, it leads: it hands work to agents and keeps\nthe conversation with you, the plan and the results.";
  if (info.project) {
    return {
      title,
      rows: [
        { kind: "note", text: what },
        {
          kind: "note",
          tone: "attention",
          text: "The project's .dwa/config.toml sets this ([main] leader), which wins over your\npersonal setting. Change it there.",
        },
        close,
      ],
    };
  }
  const main = state.main;
  if (!main) {
    return { title, rows: [{ kind: "note", text: "The workspace is not running." }, close] };
  }
  const send = async (when?: RestartWhen): Promise<Outcome> => {
    const result = await api.call<LeaderResult>("POST", "/main/leader", { on: !info.on, when });
    if (result.applied === "ask") return { to: restartScreen(main, result.reason, send) };
    return {
      to: doneScreen(`Leader mode: ${result.on ? "on" : "off"}`, [
        result.applied === "pending"
          ? "Saved in your personal config. The main session restarts when its turn ends."
          : "Saved in your personal config. The main session was restarted with its conversation.",
      ]),
    };
  };
  return {
    title,
    rows: [
      { kind: "note", text: what },
      {
        kind: "note",
        text: "The setting is yours, for every project ([main] leader in your personal config.toml).",
      },
      {
        kind: "button",
        label: info.on ? "Turn leader mode off…" : "Turn leader mode on…",
        tone: "good",
        run: () => send(),
      },
      close,
    ],
  };
}
