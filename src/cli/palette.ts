import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Agent definitions available in the project, by file name. */
export function projectRoles(projectRoot: string): string[] {
  const dir = join(projectRoot, ".claude", "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -3))
    .sort();
}
