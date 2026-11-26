import { BoxRenderable, bold, type CliRenderer, dim } from "@opentui/core";
import { APP_LOGO, APP_NAME, DEFAULT_KEY_PREFIX } from "../shared/constants.ts";
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
  /**
   * The subject is what a clicked line is about: `run:<id>` for a workflow run.
   */
  run(action: StatusAction, subject?: string): void;
  /** Shown at the very bottom. */
  version: string;
}

interface Button {
  /** The key that does the same: after the prefix anywhere, or alone while this pane has the focus. */
  key: string;
  label: (state: WorkspaceState | null) => string;
  /** Without one the line is a hint in the same shape, not a button: the key needs a choice. */
  action?: StatusAction;
}

interface Section {
  title: string;
  buttons: Button[];
}

/**
 * The shortcuts as buttons, by what they are about. Every key comes after the prefix. A pane too
 * short for them and the text above loses them from the last section up.
 */
const SECTIONS: Section[] = [
  {
    title: "Workflows",
    buttons: [
      { key: "w", label: () => "Workflows", action: "workflows" },
      { key: "g", label: () => "Workflow designer", action: "design" },
    ],
  },
  {
    title: "Agents",
    buttons: [
      { key: "a", label: () => "New agent", action: "agent" },
      { key: "t", label: () => "Agent tools", action: "tools" },
      { key: "r", label: () => "Role settings", action: "roles" },
      { key: "q", label: () => "Answer", action: "questions" },
      { key: "1-9", label: () => "Open agent" },
    ],
  },
  {
    title: "Panes",
    buttons: [
      {
        key: "s",
        label: (state) => (state?.shell?.open ? "Hide shell" : "Shell"),
        action: "shell",
      },
      { key: "0", label: () => "Focus main", action: "focus" },
      { key: "z", label: () => "Zoom main", action: "zoom" },
      { key: "x", label: () => "Close pane", action: "close" },
    ],
  },
  {
    title: "Workspace",
    buttons: [
      { key: "p", label: () => "Menu", action: "palette" },
      { key: "d", label: () => "Detach", action: "detach" },
    ],
  },
];

/** Rows of a section: a gap, its title, its buttons. */
const rows = (section: Section) => section.buttons.length + 2;

export interface StatusView {
  update(state: WorkspaceState, nowMs: number): void;
  showMessage(message: string): void;
}

/** Two rows: the label, its note and the value at the right, and a thin bar under them. */
function meter(entry: Meter, width: number): Part[][] {
  const value = entry.value ?? "N/A";
  // The note goes first when the row is too narrow for all three.
  const room = width - entry.label.length - value.length - 1;
  const note = entry.note && entry.note.length + 2 <= room ? `  ${entry.note}` : "";
  const gap = " ".repeat(Math.max(1, width - entry.label.length - note.length - value.length));
  const [used, rest] = bar(entry.percent ?? 0, width);
  return [
    [entry.label, dim(note), gap, entry.value === null ? dim(value) : value],
    [tone(percentTone(entry.percent ?? 0), used), dim(rest)],
  ];
}

/**
 * The status pane: the selected session, usage limits and workflow runs, and at the bottom, where
 * they stay however long the text above gets, the shortcuts as buttons in sections and the version.
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
  const text = createText(renderer, "status-text", undefined, false);
  /** What a click on a line of the text opens, by line number: a workflow run. */
  const targets = new Map<number, { action: StatusAction; subject?: string }>();
  text.onMouseDown = (event) => {
    const row = event.y - text.screenY;
    // The body cuts the text off; a line that is not shown cannot be clicked.
    if (row < 0 || row >= body.height) return;
    const target = targets.get(row);
    if (target) options.run(target.action, target.subject);
  };
  body.add(text);
  root.add(body);

  const bottom = new BoxRenderable(renderer, {
    id: "status-buttons",
    flexDirection: "column",
    flexShrink: 0,
    paddingTop: 1,
  });
  const addLine = (id: string, parent: BoxRenderable = bottom) => {
    const line = createText(renderer, id, 1);
    parent.add(line);
    return line;
  };
  // The prefix once, above all of them.
  const title = addLine("status-keys-title");
  const sections = SECTIONS.map((section) => {
    const id = section.title.toLowerCase();
    const box = new BoxRenderable(renderer, {
      id: `status-section-${id}`,
      flexDirection: "column",
      flexShrink: 0,
      height: rows(section),
    });
    addLine(`status-gap-${id}`, box);
    // Dim, so it is not taken for a heading of the text above (WORKFLOWS, AGENTS).
    addLine(`status-title-${id}`, box).content = styled([[dim(section.title)]]);
    const buttons = section.buttons.map((button) => {
      const { action } = button;
      const line = new BoxRenderable(renderer, {
        id: `status-button-${action ?? button.key}`,
        height: 1,
        flexShrink: 0,
        onMouseDown: action ? () => options.run(action) : undefined,
      });
      const label = createText(renderer, `status-button-text-${action ?? button.key}`, 1);
      line.add(label);
      box.add(line);
      return { button, label };
    });
    bottom.add(box);
    return { section, box, buttons };
  });
  addLine("status-gap-version");
  /** The name drawn large. The first thing left out when the pane is short, or too narrow for it. */
  const logo = createText(renderer, "status-logo", APP_LOGO.length);
  logo.content = styled(APP_LOGO.map((row) => [accent(row)]));
  bottom.add(logo);
  const version = addLine("status-version");
  version.content = styled([[dim(`${APP_NAME} ${options.version}`)]]);
  /** Rows of the bottom part without any shortcut: a gap, a gap, the version. */
  const bare = 3;
  /** Rows with the first `count` sections: the line with the prefix comes with the first one. */
  const height = (count: number) =>
    SECTIONS.slice(0, count).reduce((total, section) => total + rows(section), bare) +
    (count > 0 ? 1 : 0);
  const full = height(SECTIONS.length);
  bottom.height = full + APP_LOGO.length;
  root.add(bottom);
  renderer.root.add(root);

  const paintButtons = (state: WorkspaceState | null) => {
    for (const { button, label } of sections.flatMap((entry) => entry.buttons)) {
      const text = button.label(state);
      label.content = styled([
        button.action
          ? [accent("▸ "), bold(text), dim(`  ${button.key}`)]
          : [dim(`▸ ${text}  ${button.key}`)],
      ]);
    }
    title.content = styled([
      [bold("SHORTCUTS"), dim(`  ${formatKey(state?.keyPrefix ?? DEFAULT_KEY_PREFIX)}, then`)],
    ]);
  };
  paintButtons(null);

  renderer.keyInput.on("keypress", (key) => {
    const button = SECTIONS.flatMap((section) => section.buttons).find(
      (entry) => entry.key === key.name,
    );
    if (button?.action) options.run(button.action);
  });

  return {
    update(state, nowMs) {
      const model = statusModel(state, nowMs);
      const width = Math.max(10, renderer.width - 2);
      const lines: Part[][] = [];
      targets.clear();
      /** Adds a line that opens something when clicked. */
      const link = (line: Part[], action: StatusAction, subject?: string) => {
        targets.set(lines.length, { action, subject });
        lines.push(line);
      };

      const { subject, subjectStyle } = model;
      lines.push([bold((subject?.name ?? "main").toUpperCase())]);
      if (subject && subjectStyle) {
        // The status alone: what the session is doing or last said is in its own pane.
        lines.push([tone(subjectStyle.tone, `${subjectStyle.glyph} ${subjectStyle.label}`)]);
        lines.push([dim([model.model ?? "model N/A", model.cost ?? "cost N/A"].join(" · "))]);
        lines.push([dim(`profile ${subject.profile}`)]);
      } else {
        lines.push([dim("not running")]);
      }
      lines.push([], ...meter(model.context, width));

      lines.push([], [bold("USAGE")]);
      for (const limit of model.limits) lines.push(...meter(limit, width));

      if (model.workflows.length > 0) {
        lines.push([], [bold("WORKFLOWS")]);
        for (const run of model.workflows) {
          const opens = `run:${run.id}`;
          link(
            [fit(run.heading, width - run.state.length - 2), dim("  "), tone(run.tone, run.state)],
            "design",
            opens,
          );
          for (const step of run.steps) {
            link(
              [
                tone(step.style.tone, `  ${step.style.glyph} `),
                fit(step.name, width - 4),
                ...(step.style.label === "needs you" ? [tone("attention", " needs you")] : []),
              ],
              "design",
              opens,
            );
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

      text.content = styled(lines);
      // What needs the user must not be pushed out of sight by a list of shortcuts.
      let shown = SECTIONS.length;
      while (shown > 0 && lines.length + height(shown) > renderer.height) shown--;
      const drawn =
        lines.length + full + APP_LOGO.length <= renderer.height &&
        APP_LOGO.every((row) => row.length <= width);
      title.visible = shown > 0;
      sections.forEach(({ box }, index) => {
        box.visible = index < shown;
      });
      logo.visible = drawn;
      bottom.height = height(shown) + (drawn ? APP_LOGO.length : 0);
      paintButtons(state);
    },
    showMessage(message) {
      targets.clear();
      text.content = styled([[bold("STATUS")], [], [dim(message)]]);
    },
  };
}
