import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "../src/shared/paths.ts";

/** Runs the real `dwa hook` process against a stand-in daemon and returns what each one saw. */
describe("the hook process and the record of refusals", () => {
  let dir = "";
  let server: ReturnType<typeof Bun.serve> | undefined;
  let bodies: Record<string, unknown>[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dwa-hook-"));
    bodies = [];
    server = Bun.serve({
      unix: join(dir, "d.sock"),
      async fetch(request) {
        bodies.push((await request.json()) as Record<string, unknown>);
        return Response.json({});
      },
    });
  });
  afterEach(() => {
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  async function hook(event: string, input: unknown): Promise<string> {
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "..", "src", "cli", "index.ts"), "hook", event],
      {
        stdin: new TextEncoder().encode(JSON.stringify(input)),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          DWA_PROJECT: dir,
          DWA_SOCKET: join(dir, "d.sock"),
          DWA_AGENT_ID: "a1",
        },
      },
    );
    const out = await new Response(child.stdout).text();
    await child.exited;
    return out;
  }

  const session = () => join(runDir(dir), "agents", "a1");

  test("a skill the session was not given is refused, and the one request says so", async () => {
    mkdirSync(session(), { recursive: true });
    writeFileSync(join(session(), "skills.json"), JSON.stringify(["review"]));
    const call = { tool_name: "Skill", tool_use_id: "t1", tool_input: { skill: "deploy" } };
    const out = await hook("PreToolUse", call);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ agentId: "a1", event: "PreToolUse", input: call });
    expect(bodies[0]?.refused).toContain('The skill "deploy" is not one this session was given');
    expect(bodies[0]?.refused).toContain("report_gap");
  });

  test("a switched-off tool is reported the same way; a call that may run carries nothing", async () => {
    mkdirSync(session(), { recursive: true });
    writeFileSync(join(session(), "blocked.json"), JSON.stringify(["WebFetch"]));
    const out = await hook("PreToolUse", { tool_name: "WebFetch", tool_use_id: "t2" });
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(bodies[0]?.refused).toContain("WebFetch was switched off");

    expect(await hook("PreToolUse", { tool_name: "Read", tool_use_id: "t3" })).toBe("");
    expect(bodies).toHaveLength(2);
    expect("refused" in (bodies[1] ?? {})).toBe(false);
  });
});
