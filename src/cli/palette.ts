import { listRoles } from "../shared/roles.ts";

/** Roles a session in this project can run as: the project's and the personal ones, by name. */
export function projectRoles(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return listRoles({ projectRoot, env }).map((role) => role.name);
}
