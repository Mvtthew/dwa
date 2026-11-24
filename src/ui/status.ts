import { BoxRenderable, bold, type CliRenderer, dim } from "@opentui/core";
import type { WorkspaceState } from "../shared/protocol.ts";
import { bar, formatKey, type Meter, percentTone, statusModel } from "./model.ts";
import { createText, type Part, styled } from "./text.ts";
import { tone } from "./theme.ts";

export interface StatusView {
  update(state: WorkspaceState, nowMs: number): void;
  showMessage(message: string): void;
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

/** The status pane: the selected session, usage limits, agent counts and the shortcuts. */
export function createStatusView(renderer: CliRenderer): StatusView {
  const root = new BoxRenderable(renderer, {
    id: "status-root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    paddingX: 1,
  });
  const text = createText(renderer, "status-text");
  root.add(text);
  renderer.root.add(root);

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

      if (model.waiting.length > 0) {
        lines.push([], [tone("attention", bold("NEEDS YOU"))]);
        for (const entry of model.waiting) {
          lines.push([tone("attention", "◆ "), entry.name]);
          if (entry.detail) lines.push([dim(`  ${entry.detail}`)]);
        }
      }

      lines.push([], [bold("KEYS"), dim(`  ${formatKey(state.keyPrefix)}, then`)]);
      lines.push([dim("1-9 open agent  x close")]);
      lines.push([dim("0 main  z zoom  d detach")]);

      text.content = styled(lines);
    },
    showMessage(message) {
      text.content = styled([[bold("STATUS")], [], [dim(message)]]);
    },
  };
}
