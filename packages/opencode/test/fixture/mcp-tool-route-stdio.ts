import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

// Tools for the model-free tool route: one echo tool, one that must stay unreachable, one oversized result.
const server = new Server({ name: "mcp-tool-route-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: ["list_meetings", "get_meetings", "huge"].map((name) => ({
      name,
      inputSchema: { type: "object", properties: {} },
    })),
  }),
)

server.setRequestHandler(CallToolRequestSchema, (request) =>
  Promise.resolve({
    content: [
      {
        type: "text",
        text:
          request.params.name === "huge"
            ? "x".repeat(2 * 1024 * 1024)
            : JSON.stringify({ tool: request.params.name, arguments: request.params.arguments ?? {} }),
      },
    ],
  }),
)

await server.connect(new StdioServerTransport())
