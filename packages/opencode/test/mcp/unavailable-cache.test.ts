import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { McpAuth } from "../../src/mcp/auth"
import { MCP } from "../../src/mcp/index"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([MCP.node, McpAuth.node, CrossSpawnSpawner.node])))

// A remote MCP server that answers every request with 500, so connecting fails.
const failingServer = Effect.acquireRelease(
  Effect.sync(() => {
    let requests = 0
    const http = Bun.serve({
      port: 0,
      fetch() {
        requests++
        return new Response("down", { status: 500 })
      },
    })
    return { url: new URL("/mcp", http.url).toString(), requests: () => requests, stop: () => http.stop(true) }
  }),
  (server) => Effect.promise(server.stop),
)

const statusIn = (url: string, name: string) =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        return (yield* mcp.status())[name]
      }),
    { config: { mcp: { [name]: { type: "remote", url, oauth: false } } } },
  )

// Each new instance used to probe every unavailable remote server again: 37 such servers cost ~2.9s per cold Porter turn.
it.effect("a remote server that failed in one instance is not probed again by the next for 5 minutes", () =>
  Effect.gen(function* () {
    const server = yield* failingServer
    const name = `down-${crypto.randomUUID()}`

    const first = yield* statusIn(server.url, name)
    expect(first?.status).toBe("failed")
    const probes = server.requests()
    expect(probes).toBeGreaterThan(0)

    const second = yield* statusIn(server.url, name)
    expect(second).toEqual(first!)
    expect(server.requests()).toBe(probes)

    yield* TestClock.adjust("6 minutes")
    expect((yield* statusIn(server.url, name))?.status).toBe("failed")
    expect(server.requests()).toBeGreaterThan(probes)
  }),
)

it.effect("a changed server config probes again at once", () =>
  Effect.gen(function* () {
    const server = yield* failingServer
    const name = `down-${crypto.randomUUID()}`

    yield* statusIn(server.url, name)
    const probes = server.requests()
    yield* statusIn(`${server.url}?v=2`, name)
    expect(server.requests()).toBeGreaterThan(probes)
  }),
)

// A probe writes client registration and OAuth state into the auth entry; only stored tokens mean someone signed in.
it.effect("stored tokens probe again at once; probe-written OAuth state does not", () =>
  Effect.gen(function* () {
    const server = yield* failingServer
    const auth = yield* McpAuth.Service
    const name = `down-${crypto.randomUUID()}`
    yield* Effect.addFinalizer(() => auth.remove(name))

    yield* statusIn(server.url, name)
    const probes = server.requests()
    yield* auth.set(name, { clientInfo: { clientId: "registered" }, oauthState: "state" }, server.url)
    yield* statusIn(server.url, name)
    expect(server.requests()).toBe(probes)

    yield* auth.updateTokens(name, { accessToken: "signed-in" }, server.url)
    yield* statusIn(server.url, name)
    expect(server.requests()).toBeGreaterThan(probes)
  }),
)
