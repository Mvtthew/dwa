// Spike S4: a stdio MCP server whose `ask` tool blocks until spikes/out/answer exists.
// It sends no progress notifications, so it measures the worst case for a long wait.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const outDir = process.env.DWA_SPIKE_OUT ?? join(import.meta.dir, "out");
mkdirSync(outDir, { recursive: true });
const answerFile = join(outDir, "answer");
const log = (line: string) =>
  appendFileSync(join(outDir, "ask.log"), `${new Date().toISOString()} ${line}\n`);

const server = new McpServer({ name: "dwa", version: "0.0.0" });

server.registerTool(
  "ask",
  {
    description:
      "Ask the user a question and wait for the answer. Blocks until the user answers, however long that takes.",
    inputSchema: { question: z.string() },
  },
  async ({ question }, extra) => {
    const started = Date.now();
    log(`ask started: ${question}`);
    extra.signal.addEventListener("abort", () =>
      log(`ask ABORTED by client after ${Math.round((Date.now() - started) / 1000)}s`),
    );
    while (!existsSync(answerFile)) {
      if (extra.signal.aborted) return { content: [{ type: "text", text: "aborted" }] };
      await Bun.sleep(1000);
    }
    const answer = readFileSync(answerFile, "utf8").trim();
    rmSync(answerFile);
    log(`ask answered after ${Math.round((Date.now() - started) / 1000)}s`);
    return { content: [{ type: "text", text: `The user answered: ${answer}` }] };
  },
);

await server.connect(new StdioServerTransport());
log("server connected");
