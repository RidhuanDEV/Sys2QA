#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AppServices, openHost } from "@sys2qa/app-services";
import { createMcpServer } from "./server.js";

// The MCP server is itself a host process (Architecture §3): it holds the state database while it runs.
const home = process.env.SYS2QA_HOME;
if (!home) {
  process.stderr.write("SYS2QA_HOME must name the Sys2QA home directory\n");
  process.exit(2);
}
const host = openHost({ home });
const server = createMcpServer(new AppServices(host));
process.on("exit", () => host.close());
await server.connect(new StdioServerTransport());
