// How full a session's context window is, as the status pane and a session's status line say it.

function size(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/**
 * "5%/1M", "0.1%/1M", "41%/200k": the part of the window in use and the window's size in tokens.
 * Without a size only the percentage, and null when the percentage is not reported.
 */
export function contextText(percent: number | null, tokens: number | null): string | null {
  if (percent === null) return null;
  // A decimal only where it says something: below ten and not a whole number.
  const used =
    percent < 10 && !Number.isInteger(percent) ? percent.toFixed(1) : Math.round(percent);
  return tokens === null ? `${used}%` : `${used}%/${size(tokens)}`;
}
