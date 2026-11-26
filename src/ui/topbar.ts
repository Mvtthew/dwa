import { BoxRenderable, bold, type CliRenderer, dim, reverse } from "@opentui/core";
import type { WorkspaceState } from "../shared/protocol.ts";
import { type TopbarAction, type TopbarSegment, topbarHit, topbarModel } from "./model.ts";
import { createText, type Part, styled } from "./text.ts";
import { tone } from "./theme.ts";

export interface TopbarView {
  update(state: WorkspaceState, nowMs: number): void;
  showMessage(message: string): void;
}

function paint(segment: TopbarSegment): Part {
  if (segment.quiet) return dim(segment.text);
  if (segment.on) return reverse(bold(segment.text));
  if (segment.tone) return tone(segment.tone, bold(segment.text));
  return segment.action ? bold(segment.text) : segment.text;
}

/**
 * The bar across the top of the workspace: one row of buttons. A category opens its dropdown of
 * shortcuts just under the button, the toggles show or hide a pane, and the counts open what
 * waits for the user. `x` of a menu is the column the button starts at.
 */
export function createTopbarView(
  renderer: CliRenderer,
  run: (action: TopbarAction, x: number) => void,
): TopbarView {
  const root = new BoxRenderable(renderer, {
    id: "topbar-root",
    width: "100%",
    height: "100%",
  });
  // Clicked, so not selectable: a press on selectable text starts a selection.
  const text = createText(renderer, "topbar-text", 1, false);
  root.add(text);
  renderer.root.add(root);
  let state: WorkspaceState | null = null;
  let segments: TopbarSegment[] = [];

  const draw = () => {
    segments = topbarModel(state, renderer.width);
    const line: Part[] = [];
    let x = 0;
    for (const segment of segments) {
      if (segment.x > x) line.push(" ".repeat(segment.x - x));
      line.push(paint(segment));
      x = segment.x + segment.text.length;
    }
    text.content = styled([line]);
  };
  text.onMouseDown = (event) => {
    const hit = topbarHit(segments, event.x - text.screenX);
    if (hit?.action) run(hit.action, hit.x);
  };
  renderer.on("resize", draw);
  draw();

  return {
    update(next) {
      state = next;
      draw();
    },
    showMessage(message) {
      segments = [];
      text.content = styled([[dim(message)]]);
    },
  };
}
