// Spike S6: list the tools of an MCP server as dwa would, from a catalogue-style definition.
// Usage: bun list-tools.ts '<json server definition>' [timeout-ms]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const definition = JSON.parse(process.argv[2] ?? "{}");
const timeout = Number(process.argv[3] ?? 5000);
const started = performance.now();
const transport =
  definition.type === "http"
    ? new StreamableHTTPClientTransport(new URL(definition.url), {
        requestInit: { headers: definition.headers },
      })
    : definition.type === "sse"
      ? new SSEClientTransport(new URL(definition.url), {
          requestInit: { headers: definition.headers },
        })
      : new StdioClientTransport({
          command: definition.command,
          args: definition.args,
          env: { ...(process.env as Record<string, string>), ...definition.env },
          stderr: "ignore",
        });
const client = new Client({ name: "dwa", version: "0.0.0" });
try {
  await client.connect(transport, { timeout });
  const { tools } = await client.listTools(undefined, { timeout });
  console.log("tools:", tools.map((tool) => tool.name).join(", "));
} catch (error) {
  console.log("failed:", (error as Error).message);
} finally {
  await client.close().catch(() => undefined);
  console.log(`${Math.round(performance.now() - started)} ms`);
}
