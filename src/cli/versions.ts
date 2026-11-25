// The history of a file on the command line: the list of versions and what changed between
// two of them. Shared by `dwa role` and `dwa workflow`.
import {
  diffLines,
  formatTime,
  readHistory,
  type Tracked,
  versionText,
} from "../shared/history.ts";

/** "v3" or "3" as a number. */
export function versionNumber(text: string | undefined): number | undefined {
  const match = /^v?(\d+)$/.exec(text ?? "");
  return match ? Number(match[1]) : undefined;
}

/** Prints the versions, the newest first, with a star at the one the file is at. */
export function printHistory(tracked: Tracked, json: boolean | undefined): void {
  const history = readHistory(tracked);
  if (json) {
    console.log(JSON.stringify(history, null, 2));
    return;
  }
  for (const version of [...history.versions].reverse()) {
    const mark = version.n === history.current ? "*" : " ";
    console.log(
      `${mark} v${String(version.n).padEnd(4)}${formatTime(version.time)}  ${version.source}`,
    );
  }
}

/**
 * Prints what changed between two versions; without them, between the current version and
 * the one before. False when the versions asked for cannot be read as such.
 */
export function printDiff(tracked: Tracked, first?: string, second?: string): boolean {
  const history = readHistory(tracked);
  const to = versionNumber(second) ?? (second ? undefined : (history.current ?? undefined));
  const numbers = history.versions.map((version) => version.n).filter((n) => n < (to ?? 0));
  const from = first ? versionNumber(first) : numbers.at(-1);
  if (to === undefined || (first && from === undefined)) return false;
  if (from === undefined) {
    console.log(`v${to} is the first version; there is nothing to compare it with.`);
    return true;
  }
  const lines = diffLines(versionText(tracked, from), versionText(tracked, to));
  console.log(`v${from} → v${to}`);
  console.log(lines.length > 0 ? lines.join("\n") : "No differences.");
  return true;
}
