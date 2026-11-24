import { bold, dim, fg, RGBA, type TextChunk } from "@opentui/core";
import type { Tone } from "./model.ts";

/**
 * Colours are entries of the terminal's own 16-colour palette, so the panes follow the user's
 * theme and stay readable on whatever background it has. (OpenTUI's named helpers such as
 * `green` are fixed RGB values and do not.)
 */
const PALETTE = { red: 1, green: 2, yellow: 3 } as const;

function palette(index: number, text: string | TextChunk): TextChunk {
  return fg(RGBA.fromIndex(index))(text);
}

export function tone(kind: Tone, text: string | TextChunk): TextChunk {
  switch (kind) {
    case "good":
      return palette(PALETTE.green, text);
    case "attention":
      return palette(PALETTE.yellow, text);
    case "bad":
      return palette(PALETTE.red, text);
    case "muted":
      return dim(text);
  }
}

/**
 * Cursor marks and button arrows. No colour at all: the terminal's own text colour is the one
 * colour that is certain to contrast with its background.
 */
export const accent = bold;
