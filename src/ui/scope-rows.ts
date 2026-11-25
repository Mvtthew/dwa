// Rows and words for "in the project or personal", shared by the role settings and the
// workflow screens so both say it the same way.
import { type Scope, scopeLabel } from "../shared/scope.ts";
import type { Row, Values } from "./wizard.ts";

/** Key of the choice row in a form's values. */
export const WHERE = "where";

/** A choice between the project and the personal folder. */
export function scopeRow(what: string): Row {
  return {
    kind: "choice",
    key: WHERE,
    label: `Where the ${what} is kept`,
    options: [
      { value: "project", label: "in the project" },
      { value: "user", label: "personal, for every project" },
    ],
  };
}

export function scopeValue(values: Values): Scope {
  return values[WHERE] === "user" ? "user" : "project";
}

/** The place as a list hint, with what hides a personal file when one does. */
export function scopeHint(entry: { source: Scope; hidden: boolean }, what: string): string {
  return entry.hidden ? `personal · hidden by the project's ${what}` : scopeLabel(entry.source);
}

/** A name with its place, for titles: "review (personal)". */
export function scopeTitle(name: string, source: Scope): string {
  return `${name} (${scopeLabel(source)})`;
}

/** The button that moves a file to the other place. */
export function moveLabel(source: Scope): string {
  return source === "user" ? "Move into the project…" : "Move to your personal folder…";
}
