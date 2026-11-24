/**
 * Pulls the first dotted number out of version output such as
 * "tmux 3.8", "tmux next-3.9" or "2.1.331 (Claude Code)".
 */
export function parseVersion(text: string): number[] | null {
  const match = text.match(/\d+(?:\.\d+)*/);
  if (!match) return null;
  return match[0].split(".").map(Number);
}

/** Negative when a < b, zero when equal, positive when a > b. Missing parts count as 0. */
export function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when `actual` contains a version that is at least `minimum`. */
export function satisfiesMinimum(actual: string, minimum: string): boolean {
  const have = parseVersion(actual);
  const need = parseVersion(minimum);
  if (!have || !need) return false;
  return compareVersions(have, need) >= 0;
}
