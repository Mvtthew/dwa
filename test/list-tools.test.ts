import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { listServerTools } from "../src/mcp/list-tools.ts";

const cwd = join(import.meta.dir, "..");

describe("listServerTools", () => {
  test("lists the tools of a stdio server: dwa's own", async () => {
    const tools = await listServerTools(
      { command: "bun", args: ["src/cli/index.ts", "mcp"], env: { DWA_SOCKET: "/nonexistent" } },
      { cwd, timeoutMs: 15000 },
    );
    expect(tools).toContain("spawn_agent");
    expect(tools).toContain("send_message");
    expect(tools).toEqual([...tools].sort());
  }, 20000);

  test("fails for a command that does not exist and for a server that never answers", async () => {
    await expect(listServerTools({ command: "no-such-mcp-server-xyz" }, { cwd })).rejects.toThrow();
    await expect(
      listServerTools({ command: "sleep", args: ["30"] }, { cwd, timeoutMs: 200 }),
    ).rejects.toThrow("no answer within 200 ms");
    await expect(listServerTools({}, { cwd })).rejects.toThrow("no command and no url");
  });
});
