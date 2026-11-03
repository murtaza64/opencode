import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Clock, Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { McpServerNotFoundError, McpToolCallError, McpToolNotAllowedError } from "../errors"
import { AddPayload, AuthCallbackPayload, CallToolPayload, StatusMap, UnsupportedOAuthError } from "../groups/mcp"

// Bounds what a model-free caller can pull through Core in one response.
const TOOL_RESULT_MAX_BYTES = 1024 * 1024

export const mcpHandlers = HttpApiBuilder.group(InstanceHttpApi, "mcp", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const config = yield* Config.Service

    const status = Effect.fn("McpHttpApi.status")(function* () {
      return yield* mcp.status()
    })

    const add = Effect.fn("McpHttpApi.add")(function* (ctx: { payload: typeof AddPayload.Type }) {
      const result = (yield* mcp.add(ctx.payload.name, ctx.payload.config)).status
      return yield* Schema.decodeUnknownEffect(StatusMap)(
        "status" in result ? { [ctx.payload.name]: result } : result,
      ).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const authStart = Effect.fn("McpHttpApi.authStart")(function* (ctx: { params: { name: string } }) {
      return yield* Effect.gen(function* () {
        if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
          return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
        }
        return yield* mcp.startAuth(ctx.params.name)
      }).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
      )
    })

    const authCallback = Effect.fn("McpHttpApi.authCallback")(function* (ctx: {
      params: { name: string }
      payload: typeof AuthCallbackPayload.Type
    }) {
      return yield* mcp
        .finishAuth(ctx.params.name, ctx.payload.code)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
    })

    const authAuthenticate = Effect.fn("McpHttpApi.authAuthenticate")(function* (ctx: { params: { name: string } }) {
      return yield* Effect.gen(function* () {
        if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
          return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
        }
        return yield* mcp.authenticate(ctx.params.name)
      }).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
      )
    })

    const authRemove = Effect.fn("McpHttpApi.authRemove")(function* (ctx: { params: { name: string } }) {
      const status = yield* mcp.status()
      if (!(ctx.params.name in status))
        return yield* new McpServerNotFoundError({
          name: ctx.params.name,
          message: `MCP server not found: ${ctx.params.name}`,
        })
      yield* mcp.removeAuth(ctx.params.name)
      return { success: true as const }
    })

    const connect = Effect.fn("McpHttpApi.connect")(function* (ctx: { params: { name: string } }) {
      yield* mcp
        .connect(ctx.params.name)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
      return true
    })

    const disconnect = Effect.fn("McpHttpApi.disconnect")(function* (ctx: { params: { name: string } }) {
      yield* mcp
        .disconnect(ctx.params.name)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
      return true
    })

    const callTool = Effect.fn("McpHttpApi.callTool")(function* (ctx: {
      params: { name: string; tool: string }
      payload: typeof CallToolPayload.Type
    }) {
      const server = ctx.params.name
      const tool = ctx.params.tool
      const allowed = ((yield* config.get()).experimental?.mcp_tool_routes ?? []).some(
        (route) => route.server === server && route.tool === tool,
      )
      if (!allowed)
        return yield* new McpToolNotAllowedError({ server, tool, message: `MCP tool not found: ${server}/${tool}` })
      const started = yield* Clock.currentTimeMillis
      const result = yield* mcp.callTool(server, tool, ctx.payload.arguments)
      if (!result)
        return yield* new McpToolCallError({ server, tool, message: `MCP tool unavailable: ${server}/${tool}` })
      const bytes = Buffer.byteLength(JSON.stringify(result))
      // Metadata only: arguments and results may carry meeting titles or other private text.
      yield* Effect.logInfo("mcp tool route call", { server, tool, ms: (yield* Clock.currentTimeMillis) - started, bytes })
      if (bytes > TOOL_RESULT_MAX_BYTES)
        return yield* new McpToolCallError({
          server,
          tool,
          message: `MCP tool result is ${bytes} bytes, over the ${TOOL_RESULT_MAX_BYTES} byte limit`,
        })
      return result
    })

    return handlers
      .handle("status", status)
      .handle("callTool", callTool)
      .handle("add", add)
      .handle("authStart", authStart)
      .handle("authCallback", authCallback)
      .handle("authAuthenticate", authAuthenticate)
      .handle("authRemove", authRemove)
      .handle("connect", connect)
      .handle("disconnect", disconnect)
  }),
)
