import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { main } from "../../apps/cli/src/index.js";
import { createMcpServer } from "../../apps/mcp/src/index.js";
import {
  ApiClient,
  AppServices,
  openHost,
  startApiServer,
  type ServiceResult,
} from "../../packages/app-services/src/index.js";
import { createIdGenerator, memorySink } from "../../packages/platform/src/index.js";

/** Every runner starts from an empty home with the same clock and ID sequence, so equal behavior means equal output. */
export function deterministic(adapters?: ReadonlyArray<{ id: string; entry: string }>) {
  const now = () => new Date("2026-10-22T10:00:00.000Z");
  return {
    now,
    newId: createIdGenerator(now, (n) => new Uint8Array(n)),
    logSink: memorySink(),
    ...(adapters ? { adapters } : {}),
  };
}

type Adapters = ReadonlyArray<{ id: string; entry: string }>;

export interface Runner {
  name: "cli" | "api" | "mcp";
  run(operation: string, input: unknown): Promise<{ result: ServiceResult; exitCode?: number }>;
  close(): Promise<void>;
}

export async function cliRunner(adapters?: Adapters): Promise<Runner & { home: string }> {
  const home = mkdtempSync(join(tmpdir(), "sys2qa-parity-cli-"));
  const host = deterministic(adapters);
  return {
    name: "cli",
    home,
    async run(operation, input) {
      let out = "";
      const exitCode = await main(["call", operation, "--input", JSON.stringify(input), "--json", "--home", home], {
        stdout: (t) => (out += t),
        stderr: () => {},
        cwd: home,
        env: {},
        host,
      });
      return { result: JSON.parse(out) as ServiceResult, exitCode };
    },
    close: async () => rmSync(home, { recursive: true, force: true }),
  };
}

export async function apiRunner(adapters?: Adapters): Promise<Runner & { home: string }> {
  const home = mkdtempSync(join(tmpdir(), "sys2qa-parity-api-"));
  const host = openHost({ home, ...deterministic(adapters) });
  const server = await startApiServer(new AppServices(host));
  const client = new ApiClient(server.url, server.token);
  return {
    name: "api",
    home,
    run: async (operation, input) => ({ result: await client.execute(operation, input) }),
    close: async () => {
      await server.close();
      host.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export async function mcpRunner(adapters?: Adapters): Promise<Runner & { client: Client; home: string }> {
  const home = mkdtempSync(join(tmpdir(), "sys2qa-parity-mcp-"));
  const host = openHost({ home, ...deterministic(adapters) });
  const server = createMcpServer(new AppServices(host));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parity", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    name: "mcp",
    client,
    home,
    async run(operation, input) {
      const response = await client.callTool({ name: operation, arguments: input as Record<string, unknown> });
      return { result: response.structuredContent as ServiceResult };
    },
    close: async () => {
      await client.close();
      await server.close();
      host.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
