import { Effect, Schema } from "effect"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { EffectBridge } from "@/effect/bridge"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "enable"]).annotate({
    description: "list: every configured MCP server and its status. enable: connect one server, signing in if it needs auth",
  }),
  name: Schema.optional(Schema.String).annotate({ description: "Server name, required for enable" }),
})

type Metadata = { name?: string; status?: string; authorizationUrl?: string }

export const DESCRIPTION = [
  "Lists MCP servers and enables one on demand. Servers that are off or need sign-in contribute no tools until enabled.",
  "Use enable only when the task needs that server's tools. Enabling a server that needs auth opens a sign-in page for the",
  "human and waits for it. Enabled tools appear from the next step and stay until this directory's instance restarts.",
].join(" ")

export const McpServersTool = Tool.define<typeof Parameters, Metadata, MCP.Service | Config.Service>(
  "mcp_servers",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const config = yield* Config.Service

    const servers = Effect.fnUntraced(function* () {
      const status = yield* mcp.status()
      const entries = Object.entries((yield* config.get()).mcp ?? {}).flatMap(([name, entry]) =>
        "type" in entry ? [{ name, entry, status: status[name]?.status ?? "disabled" }] : [],
      )
      return entries.toSorted((a, b) => a.name.localeCompare(b.name))
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const list = yield* servers()
          if (params.action === "list")
            return {
              title: `${list.length} MCP servers`,
              output: list.map((item) => `- ${item.name} (${item.status}): ${purpose(item.entry)}`).join("\n"),
              metadata: {},
            }

          const server = list.find((item) => item.name === params.name)
          if (!server)
            return {
              title: "Unknown MCP server",
              output: `No MCP server named "${params.name ?? ""}". Configured: ${list.map((item) => item.name).join(", ")}`,
              metadata: {},
            }
          if (server.status === "connected")
            return { title: `${server.name} connected`, output: `${server.name} is already connected.`, metadata: {} }

          yield* ctx.ask({
            permission: "mcp_servers",
            patterns: [server.name],
            always: [server.name],
            metadata: { name: server.name, status: server.status },
          })
          yield* mcp.connect(server.name).pipe(Effect.orDie)
          const bridge = yield* EffectBridge.make()
          const connected = (yield* mcp.status())[server.name]?.status ?? "disabled"
          const status =
            connected === "needs_auth" && (yield* mcp.supportsOAuth(server.name).pipe(Effect.orDie))
              ? (yield* mcp
                  .authenticate(server.name, (authorizationUrl) =>
                    bridge.fork(
                      ctx.metadata({ title: `Sign in to ${server.name}`, metadata: { name: server.name, authorizationUrl } }),
                    ),
                  )
                  .pipe(Effect.orDie)).status
              : connected
          return {
            title: `${server.name} ${status}`,
            output:
              status === "connected"
                ? `${server.name} is connected; its tools are available from the next step.`
                : `${server.name} is ${status}. The human can sign in with: opencode mcp auth ${server.name}`,
            metadata: { name: server.name, status },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

/** The catalog shown in the tool description: servers turned off in config, by name and purpose (never their schemas). */
export function catalog(entries: Record<string, ConfigMCPV1.Info | { enabled: boolean }>) {
  const off = Object.entries(entries)
    .flatMap(([name, entry]) => ("type" in entry && entry.enabled === false ? [{ name, entry }] : []))
    .toSorted((a, b) => a.name.localeCompare(b.name))
  if (off.length === 0) return
  return ["Servers turned off by default (enable with this tool):", ...off.map((item) => `- ${item.name}: ${purpose(item.entry)}`)].join("\n")
}

function purpose(entry: ConfigMCPV1.Info) {
  if (entry.description) return entry.description
  if (entry.type === "remote") return URL.canParse(entry.url) ? new URL(entry.url).host : entry.url
  return "local server"
}
