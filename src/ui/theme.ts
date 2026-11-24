import { blue, dim, green, red, type TextChunk, yellow } from "@opentui/core";
import type { Tone } from "./model.ts";

/**
 * Colours come from the terminal's own palette (the named ANSI colours), so the panes follow
 * the user's theme in light and dark terminals alike.
 */
export function tone(kind: Tone, text: string | TextChunk): TextChunk {
  switch (kind) {
    case "good":
      return green(text);
    case "attention":
      return yellow(text);
    case "bad":
      return red(text);
    case "muted":
      return dim(text);
  }
}

export const accent = blue;
