import { BoxRenderable, bold, type CliRenderer, dim } from "@opentui/core";
import { APP_LOGO, APP_NAME } from "../shared/constants.ts";
import type { WorkspaceState } from "../shared/protocol.ts";
import { bar, fit, type Meter, percentTone, statusModel } from "./model.ts";
import { createText, type Part, styled } from "./text.ts";
import { accent, tone } from "./theme.ts";

/** What a clicked line of the status pane opens: the designer, at a workflow run. */
export type StatusAction = "design";

export interface StatusOptions {
  /**
   * The subject is what a clicked line is about: `run:<id>` for a workflow run.
   */
  run(action: StatusAction, subject?: string): void;
  /** Shown at the very bottom. */
  version: string;
}

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
 * The status pane: the selected session, usage limits and workflow runs, and at the bottom the
 * logo and the version. The shortcuts are in the top bar.
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
    id: "status-bottom",
    flexDirection: "column",
    flexShrink: 0,
  });
  const addLine = (id: string) => {
    const line = createText(renderer, id, 1);
    bottom.add(line);
    return line;
  };
  addLine("status-gap-version");
  /** The name drawn large. The first thing left out when the pane is short, or too narrow for it. */
  const logo = createText(renderer, "status-logo", APP_LOGO.length);
  logo.content = styled(APP_LOGO.map((row) => [accent(row)]));
  bottom.add(logo);
  const version = addLine("status-version");
  version.content = styled([[dim(`${APP_NAME} ${options.version}`)]]);
  /** Rows of the bottom part without the logo: a gap and the version. */
  const bare = 2;
  bottom.height = bare + APP_LOGO.length;
  root.add(bottom);
  renderer.root.add(root);

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
      // What needs the user must not be pushed out of sight by the logo.
      const drawn =
        lines.length + bare + APP_LOGO.length <= renderer.height &&
        APP_LOGO.every((row) => row.length <= width);
      logo.visible = drawn;
      bottom.height = bare + (drawn ? APP_LOGO.length : 0);
    },
    showMessage(message) {
      targets.clear();
      text.content = styled([[bold("STATUS")], [], [dim(message)]]);
    },
  };
}
