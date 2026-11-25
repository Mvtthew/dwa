import { describe, expect, test } from "bun:test";
import { guideEntries, roleGuideList, roleGuidePrompt } from "../src/shared/role-guide.ts";
import type { RoleContext, RoleFiles } from "../src/shared/roles.ts";

const ROOT = "/p";
const ROLES = `${ROOT}/.dwa/roles`;
const USER_ROLES = "/home/.config/dwa/roles";

function context(entries: Record<string, string>): RoleContext {
  const paths = Object.keys(entries);
  const files: RoleFiles = {
    read: (path) => entries[path] ?? null,
    exists: (path) => paths.some((known) => known === path || known.startsWith(`${path}/`)),
    list: (dir) => [
      ...new Set(
        paths
          .filter((known) => known.startsWith(`${dir}/`))
          .map((known) => known.slice(dir.length + 1).split("/")[0] as string),
      ),
    ],
    which: () => null,
  };
  return { projectRoot: ROOT, env: { XDG_CONFIG_HOME: "/home/.config" }, files };
}

const FILES = {
  [`${ROLES}/main.toml`]: 'description = "Leads."\nrole_list = true\nin_role_list = false',
  [`${ROLES}/developer.toml`]: 'description = "Implements a scoped change."',
  [`${ROLES}/explore.toml`]:
    'description = "Reads the code."\nwhen_to_use = """\nUse for questions about the code.\nNot for changes.\n"""',
  [`${ROLES}/bare.toml`]: 'model = "sonnet"',
  [`${USER_ROLES}/runner.toml`]: 'when_to_use = "Runs tests and builds."',
  [`${USER_ROLES}/developer.toml`]: 'description = "Hidden by the project."',
};

describe("the roles a session can hand work to", () => {
  test("takes when_to_use, then the description, from project and personal roles", () => {
    expect(guideEntries(context(FILES))).toEqual([
      { name: "bare", guidance: "" },
      { name: "developer", guidance: "Implements a scoped change." },
      { name: "explore", guidance: "Use for questions about the code.\nNot for changes." },
      { name: "runner", guidance: "Runs tests and builds." },
    ]);
  });

  test("leaves out the session's own role and the roles that keep themselves out", () => {
    const names = (except?: string) =>
      guideEntries(context(FILES), { except }).map((entry) => entry.name);
    expect(names()).not.toContain("main");
    expect(names("developer")).toEqual(["bare", "explore", "runner"]);
  });

  test("a role on one line stays on the name's line, a longer one goes beneath it", () => {
    expect(roleGuidePrompt(guideEntries(context(FILES)))).toBe(
      [
        "# Roles you can hand work to",
        "",
        "Start one with spawn_agent (role, task). This list is from the start of your session; list_roles gives the current one.",
        "",
        "- bare",
        "- developer: Implements a scoped change.",
        "- explore:",
        "  Use for questions about the code.",
        "  Not for changes.",
        "- runner: Runs tests and builds.",
      ].join("\n"),
    );
  });

  test("a file that does not parse is left out of the prompt and named by the list", () => {
    const entries = guideEntries(context({ ...FILES, [`${ROLES}/broken.toml`]: "colour = 1" }));
    expect(roleGuidePrompt(entries)).not.toContain("broken");
    expect(roleGuideList(entries)).toMatch(/^- broken: cannot be used, its file has an error \(/m);
    expect(roleGuideList(entries)).toContain("- developer: Implements a scoped change.");
  });

  test("without a role to offer there is no prompt part, and the list says so", () => {
    const only = context({ [`${ROLES}/main.toml`]: FILES[`${ROLES}/main.toml`] as string });
    expect(roleGuidePrompt(guideEntries(only))).toBe("");
    expect(roleGuideList(guideEntries(only))).toBe("No roles to hand work to (.dwa/roles/*.toml).");
    const broken = context({ [`${ROLES}/broken.toml`]: "colour = 1" });
    expect(roleGuidePrompt(guideEntries(broken))).toBe("");
  });
});
