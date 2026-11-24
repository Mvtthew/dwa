import { type CliRenderer, RGBA, StyledText, type TextChunk, TextRenderable } from "@opentui/core";

export type Part = string | TextChunk;

function chunk(part: Part): TextChunk {
  return typeof part === "string" ? { __isChunk: true, text: part } : part;
}

/** Joins lines, each a list of plain strings and styled chunks, into one styled text. */
export function styled(lines: Part[][]): StyledText {
  const chunks: TextChunk[] = [];
  lines.forEach((line, index) => {
    if (index > 0) chunks.push(chunk("\n"));
    chunks.push(...line.map(chunk));
  });
  return new StyledText(chunks);
}

/**
 * A text element that uses the terminal's own foreground colour (OpenTUI's default is white,
 * which disappears on light themes) and is clipped at the pane edge instead of wrapping.
 */
export function createText(renderer: CliRenderer, id: string, height?: number): TextRenderable {
  return new TextRenderable(renderer, {
    id,
    fg: RGBA.defaultForeground(),
    wrapMode: "none",
    flexShrink: 0,
    ...(height === undefined ? {} : { height }),
  });
}
