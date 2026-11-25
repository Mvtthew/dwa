// The workflow picture on screen: one piece of styled text in a box that scrolls both ways,
// with the mouse on it. What the picture is comes from `src/shared/diagram.ts`.
import {
  bold,
  type CliRenderer,
  dim,
  type MouseEvent,
  RGBA,
  reverse,
  ScrollBoxRenderable,
  type TextChunk,
  TextRenderable,
} from "@opentui/core";
import { type Cell, type Diagram, hit, type Region } from "../shared/diagram.ts";
import { type Part, styled } from "./text.ts";
import { tone } from "./theme.ts";

export interface DiagramHandlers {
  /** A press on the picture: what is there, or null for an empty place. */
  press(region: Region | null): void;
  /** The pointer moved with the button held, from where it was pressed to what is under it now. */
  drag(from: Region | null, over: Region | null): void;
  /** The button was let go after a drag. */
  drop(from: Region | null, over: Region | null): void;
}

export interface DiagramView {
  /** The scrolling box, to be added where the picture should show. */
  box: ScrollBoxRenderable;
  draw(diagram: Diagram): void;
  /** Scrolls so that this part of the picture can be seen. */
  reveal(x: number, y: number, width: number, height: number): void;
  destroy(): void;
}

function chunkOf(cell: Cell, text: string): Part {
  let part: string | TextChunk = text;
  if (cell.tone) part = tone(cell.tone, part);
  if (cell.dim) part = dim(part);
  // Inverse video shows the cursor on any theme; bold keeps it readable there.
  if (cell.inverse) part = reverse(bold(part));
  return part;
}

const sameStyle = (a: Cell, b: Cell) =>
  a.tone === b.tone &&
  Boolean(a.dim) === Boolean(b.dim) &&
  Boolean(a.inverse) === Boolean(b.inverse);

/** A row of cells as few pieces of styled text as its styles allow. */
export function rowParts(row: Cell[]): Part[] {
  const parts: Part[] = [];
  let start = 0;
  for (let x = 1; x <= row.length; x++) {
    const first = row[start] as Cell;
    const here = row[x];
    if (here && sameStyle(first, here)) continue;
    parts.push(
      chunkOf(
        first,
        row
          .slice(start, x)
          .map((cell) => cell.char)
          .join(""),
      ),
    );
    start = x;
  }
  return parts;
}

export function createDiagramView(
  renderer: CliRenderer,
  id: string,
  handlers: DiagramHandlers,
): DiagramView {
  const box = new ScrollBoxRenderable(renderer, {
    id: `${id}-scroll`,
    flexGrow: 1,
    flexShrink: 1,
    scrollX: true,
    scrollY: true,
    verticalScrollbarOptions: { visible: false },
    horizontalScrollbarOptions: { visible: false },
  });
  const text = new TextRenderable(renderer, {
    id: `${id}-text`,
    fg: RGBA.defaultForeground(),
    wrapMode: "none",
    flexShrink: 0,
    // A press on selectable text starts a text selection instead of a drag of ours.
    selectable: false,
  });

  let diagram: Diagram | null = null;
  let pressed: Region | null = null;
  const under = (event: MouseEvent): Region | null =>
    diagram ? hit(diagram, event.x - text.screenX, event.y - text.screenY) : null;
  text.onMouseDown = (event) => {
    pressed = under(event);
    handlers.press(pressed);
  };
  text.onMouseDrag = (event) => {
    // Carrying something to the edge of a picture larger than its box moves the picture along.
    const column = event.x - box.screenX;
    const row = event.y - box.screenY;
    if (row <= 0) box.scrollTop = Math.max(0, box.scrollTop - 1);
    else if (row >= box.height - 1) box.scrollTop += 1;
    if (column <= 0) box.scrollLeft = Math.max(0, box.scrollLeft - 2);
    else if (column >= box.width - 1) box.scrollLeft += 2;
    handlers.drag(pressed, under(event));
  };
  text.onMouseDragEnd = (event) => {
    handlers.drop(pressed, under(event));
    pressed = null;
  };
  // A press beside the picture takes the cursor off it.
  box.onMouseDown = (event) => {
    if (event.target === text) return;
    pressed = null;
    handlers.press(null);
  };

  box.add(text);

  return {
    box,
    draw: (next) => {
      diagram = next;
      text.width = Math.max(1, next.width);
      text.height = Math.max(1, next.height);
      text.content = styled(next.cells.map(rowParts));
    },
    reveal: (x, y, width, height) => {
      const view = { width: box.width, height: box.height };
      if (y < box.scrollTop) box.scrollTop = y;
      else if (y + height > box.scrollTop + view.height) {
        box.scrollTop = Math.max(0, y + height - view.height);
      }
      if (x < box.scrollLeft) box.scrollLeft = x;
      else if (x + width > box.scrollLeft + view.width) {
        box.scrollLeft = Math.max(0, x + width - view.width);
      }
    },
    destroy: () => box.destroyRecursively(),
  };
}
