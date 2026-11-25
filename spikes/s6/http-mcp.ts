// Spike S6: a minimal stateless streamable-HTTP MCP server with one `ping` tool. Usage: bun http-mcp.ts <port>
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

Bun.serve({
  port: Number(process.argv[2] ?? 39411),
  hostname: "127.0.0.1",
  async fetch(request) {
    if (request.headers.get("authorization") !== "Bearer s6")
      return new Response("no", { status: 401 });
    const server = new McpServer({ name: "httpsrv", version: "0.0.0" });
    server.registerTool("ping", { description: "http ping", inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
});
