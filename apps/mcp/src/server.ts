import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PRODUCT_VERSION, type AppServices } from "@sys2qa/app-services";

/**
 * MCP server over the application services (Architecture §8, SYS-005): one tool per operation, with the operation's JSON
 * Schema as input schema and its permission level and side effect declared on the tool (SEC-006). Calls go through
 * `AppServices.execute`, so decisions, states and errors are identical to the CLI and the HTTP API.
 */
export function createMcpServer(services: AppServices, options: { actor?: string } = {}): Server {
  const server = new Server({ name: "sys2qa", version: PRODUCT_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: services.catalog("mcp").map((op) => ({
      name: op.name,
      title: op.title,
      description: `${op.description} Permission level: ${op.level}; effect: ${op.effect}.`,
      inputSchema: op.input as { type: "object"; [key: string]: unknown },
      annotations: {
        title: op.title,
        readOnlyHint: op.effect === "read",
        destructiveHint: op.destructive,
        idempotentHint: op.effect === "read",
        openWorldHint: false,
      },
      _meta: { "sys2qa/level": op.level, "sys2qa/effect": op.effect },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await services.execute(request.params.name, request.params.arguments ?? {}, {
      interface: "mcp",
      actor: options.actor ?? "mcp-client",
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result as unknown as Record<string, unknown>,
      isError: !result.ok,
    };
  });

  return server;
}
