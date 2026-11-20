import { expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Effect } from "effect"
import type { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "../../src/mcp"
import { McpServersTool } from "../../src/tool/mcp-servers"
import { provideTmpdirInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node, MCP.node, CrossSpawnSpawner.node, Ripgrep.node])))

const server = Effect.acquireRelease(
  Effect.promise(async () => {
    const protocol = new Server({ name: "off-server", version: "1.0.0" }, { capabilities: { tools: {} } })
    protocol.setRequestHandler(ListToolsRequestSchema, () =>
      Promise.resolve({ tools: [{ name: "lookup", inputSchema: { type: "object" } }] }),
    )
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() })
    await protocol.connect(transport)
    const http = Bun.serve({ port: 0, fetch: (request) => transport.handleRequest(request) })
    return { url: new URL("/mcp", http.url).toString(), close: () => http.stop(true) }
  }),
  (item) => Effect.promise(item.close),
)

const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
const model = { providerID: "opencode" as never, modelID: "gpt-5" as never, agent }

// Murtaza (2026-11-20): disabled MCP servers stay discoverable, and an agent can enable one when needed.
it.live("a server turned off in config is listed by purpose and can be enabled on demand", () =>
  Effect.gen(function* () {
    const mcp = yield* server
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const tool = (yield* registry.tools(model)).find((item) => item.id === McpServersTool.id)
          if (!tool) throw new Error("mcp_servers tool not offered")
          expect(tool.description).toContain("- off-server: Test lookups")
          expect(tool.description).not.toContain("lookup\"")
          expect((yield* (yield* MCP.Service).status())["off-server"]?.status).toBe("disabled")

          const asked: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const ctx: Tool.Context = {
            sessionID: SessionID.make("ses_test"),
            messageID: MessageID.make("msg_test"),
            callID: "",
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: (request) => Effect.sync(() => void asked.push(request)),
          }
          expect((yield* tool.execute({ action: "list" }, ctx)).output).toBe("- off-server (disabled): Test lookups")
          const enabled = yield* tool.execute({ action: "enable", name: "off-server" }, ctx)
          expect(enabled.metadata.status).toBe("connected")
          expect(asked.map((item) => [item.permission, item.patterns])).toEqual([["mcp_servers", ["off-server"]]])
          expect(Object.keys(yield* (yield* MCP.Service).tools())).toContain("off-server_lookup")
        }),
      {
        config: {
          mcp: {
            "off-server": { type: "remote", url: mcp.url, oauth: false, enabled: false, description: "Test lookups" },
          },
        },
      },
    )
  }),
)

it.live("the tool is not offered when no server is turned off", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect((yield* registry.tools(model)).map((item) => item.id)).not.toContain(McpServersTool.id)
    }),
  ),
)
