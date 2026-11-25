import { BoxRenderable, bold, type CliRenderer, dim } from "@opentui/core";
import { APP_NAME, DEFAULT_KEY_PREFIX } from "../shared/constants.ts";
import type { WorkspaceState } from "../shared/protocol.ts";
import { bar, fit, formatKey, type Meter, percentTone, statusModel } from "./model.ts";
import { createText, type Part, styled } from "./text.ts";
import { accent, tone } from "./theme.ts";

/** What a button in the status pane asks for. */
export type StatusAction =
  | "workflows"
  | "agent"
  | "tools"
  | "roles"
  | "design"
  | "shell"
  | "close"
  | "focus"
  | "questions"
  | "palette"
  | "zoom"
  | "detach";

export interface StatusOptions {
  run(action: StatusAction): void;
  /** Shown at the very bottom. */
  version: string;
}

interface Button {
  /** The key that does the same: after the prefix anywhere, or alone while this pane has the focus. */
  key: string;
  label: (state: WorkspaceState | null) => string;
  action: StatusAction;
}

/** The actions: things that open or show something. */
const ACTIONS: Button[] = [
  { key: "w", label: () => "Workflows", action: "workflows" },
  { key: "g", label: () => "Workflow designer", action: "design" },
  { key: "a", label: () => "New agent", action: "agent" },
  { key: "t", label: () => "Agent tools", action: "tools" },
  { key: "r", label: () => "Role settings", action: "roles" },
  { key: "s", label: (state) => (state?.shell?.open ? "Hide shell" : "Shell"), action: "shell" },
];

/** The remaining shortcuts, as buttons too. */
const KEYS: Button[] = [
  { key: "x", label: () => "Close pane", action: "close" },
  { key: "0", label: () => "Focus main", action: "focus" },
  { key: "q", label: () => "Answer", action: "questions" },
  { key: "p", label: () => "Menu", action: "palette" },
  { key: "z", label: () => "Zoom main", action: "zoom" },
  { key: "d", label: () => "Detach", action: "detach" },
];

export interface StatusView {
  update(state: WorkspaceState, nowMs: number): void;
  showMessage(message: string): void;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function meter(entry: Meter, width: number): Part[][] {
  const title: Part[] = [entry.label, ...(entry.note ? [dim(`  ${entry.note}`)] : [])];
  if (entry.percent === null) return [title, [dim("N/A")]];
  const percent = Math.round(entry.percent);
  return [
    title,
    [tone(percentTone(percent), bar(percent, Math.max(4, width - 5))), ` ${percent}%`],
  ];
}

/**
 * The status pane: the selected session, usage limits and agent counts, and at the bottom, where
 * they stay however long the text above gets, the actions and shortcuts as buttons and the version.
 */
export function createStatusView(renderer: CliRenderer, options: StatusOptions): StatusView {
  const root = new BoxRenderable(renderer, {
    id: "status-root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    paddingX: 1,
  });
  const body = new BoxRenderable(renderer, {
    id: "status-body",
    flexGrow: 1,
    flexShrink: 1,
    overflow: "hidden",
  });
  const text = createText(renderer, "status-text");
  body.add(text);
  root.add(body);

  const bottom = new BoxRenderable(renderer, {
    id: "status-buttons",
    flexDirection: "column",
    flexShrink: 0,
    paddingTop: 1,
  });
  /** The shortcuts. Left out when the pane is too short to show them and the text above. */
  const keys = new BoxRenderable(renderer, {
    id: "status-keys",
    flexDirection: "column",
    flexShrink: 0,
    height: KEYS.length + 3,
  });
  const addLine = (id: string, parent: BoxRenderable = bottom) => {
    const line = createText(renderer, id, 1);
    parent.add(line);
    return line;
  };
  const addButtons = (list: Button[], parent: BoxRenderable = bottom) =>
    list.map((button) => {
      const box = new BoxRenderable(renderer, {
        id: `status-button-${button.action}`,
        height: 1,
        flexShrink: 0,
        onMouseDown: () => options.run(button.action),
      });
      const label = createText(renderer, `status-button-text-${button.action}`, 1);
      box.add(label);
      parent.add(box);
      return { button, label };
    });

  const actionButtons = addButtons(ACTIONS);
  addLine("status-gap-keys", keys);
  const keysTitle = addLine("status-keys-title", keys);
  const agentKeys = addLine("status-keys-agents", keys);
  const keyButtons = addButtons(KEYS, keys);
  bottom.add(keys);
  addLine("status-gap-version");
  const version = addLine("status-version");
  version.content = styled([[dim(`${APP_NAME} ${options.version}`)]]);
  // Opening an agent needs a number, so it is a hint in the same shape, not a button.
  agentKeys.content = styled([[dim("▸ Open agent  1-9")]]);
  /** Rows of the bottom part without the shortcuts: a gap, the actions, a gap, the version. */
  const compact = ACTIONS.length + 3;
  const full = compact + KEYS.length + 3;
  bottom.height = full;
  root.add(bottom);
  renderer.root.add(root);

  const paintButtons = (state: WorkspaceState | null) => {
    for (const { button, label } of [...actionButtons, ...keyButtons]) {
      label.content = styled([[accent("▸ "), bold(button.label(state)), dim(`  ${button.key}`)]]);
    }
    keysTitle.content = styled([
      [bold("KEYS"), dim(`  ${formatKey(state?.keyPrefix ?? DEFAULT_KEY_PREFIX)}, then`)],
    ]);
  };
  paintButtons(null);

  renderer.keyInput.on("keypress", (key) => {
    const button = [...ACTIONS, ...KEYS].find((entry) => entry.key === key.name);
    if (button) options.run(button.action);
  });

  return {
    update(state, nowMs) {
      const model = statusModel(state, nowMs);
      const width = Math.max(10, renderer.width - 2);
      const lines: Part[][] = [];

      const { subject, subjectStyle } = model;
      lines.push([bold((subject?.name ?? "main").toUpperCase())]);
      if (subject && subjectStyle) {
        lines.push([
          tone(subjectStyle.tone, `${subjectStyle.glyph} ${subjectStyle.label}`),
          ...(subject.detail ? [dim(` · ${subject.detail}`)] : []),
        ]);
        lines.push([dim([model.model ?? "model N/A", model.cost ?? "cost N/A"].join(" · "))]);
        lines.push([dim(`profile ${subject.profile}`)]);
      } else {
        lines.push([dim("not running")]);
      }
      lines.push([], ...meter(model.context, width));

      lines.push([], [bold("USAGE")]);
      for (const limit of model.limits) lines.push(...meter(limit, width));

      const { counts } = model;
      lines.push([], [bold(`AGENTS ${counts.total}`)]);
      if (counts.total > 0) {
        lines.push([dim(`${counts.working} working · ${counts.idle} idle`)]);
      }

      if (model.workflows.length > 0) {
        lines.push([], [bold("WORKFLOWS")]);
        for (const run of model.workflows) {
          lines.push([
            fit(run.heading, width - run.state.length - 2),
            dim("  "),
            tone(run.tone, run.state),
          ]);
          for (const step of run.steps) {
            lines.push([
              tone(step.style.tone, `  ${step.style.glyph} `),
              fit(step.name, width - 4),
              ...(step.style.label === "needs you" ? [tone("attention", " needs you")] : []),
            ]);
          }
        }
      }

      if (model.waiting.length > 0) {
        lines.push([], [tone("attention", bold("NEEDS YOU"))]);
        for (const entry of model.waiting) {
          lines.push([tone("attention", "◆ "), entry.name]);
          if (entry.detail) lines.push([dim(`  ${entry.detail}`)]);
        }
      }

      if (model.questions.length > 0) {
        const mine = model.questions.some((question) => question.forUser);
        const title = bold(`QUESTIONS ${model.questions.length}`);
        lines.push([], [mine ? tone("attention", title) : title]);
        for (const question of model.questions.slice(0, 4)) {
          lines.push([question.forUser ? tone("attention", "◆ ") : dim("◷ "), question.heading]);
          lines.push([dim(`  ${fit(oneLine(question.text), width - 2)}`)]);
        }
        lines.push([dim(`  ${formatKey(state.keyPrefix)} q to answer`)]);
      }

      if (model.inbox.length > 0) {
        lines.push([], [bold("MESSAGES TO YOU")]);
        for (const message of model.inbox.slice(0, 3)) {
          lines.push([`from ${message.from}`, dim(`  ${message.age}`)]);
          lines.push([dim(`  ${fit(oneLine(message.text), width - 2)}`)]);
        }
      }

      text.content = styled(lines);
      // What needs the user must not be pushed out of sight by a list of shortcuts.
      const roomy = lines.length + full <= renderer.height;
      keys.visible = roomy;
      bottom.height = roomy ? full : compact;
      paintButtons(state);
    },
    showMessage(message) {
      text.content = styled([[bold("STATUS")], [], [dim(message)]]);
    },
  };
}
