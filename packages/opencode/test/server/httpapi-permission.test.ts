import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { describe, expect } from "bun:test"
import { Config, Effect, Fiber, FileSystem, Layer, Path } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { Agent } from "../../src/agent/agent"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { Permission } from "../../src/permission"
import { InstanceStore } from "../../src/project/instance-store"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "../../src/session/session"
import { MessageID } from "../../src/session/schema"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { Truncate } from "../../src/tool/truncate"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffectShared } from "../lib/effect"

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

// Share the production service graph so the tool and HTTP handlers see the same pending request.
const it = testEffectShared(
  Layer.mergeAll(
    AppNodeBuilderV1.build(
      LayerNode.group([
        LSP.node,
        FSUtil.node,
        Format.node,
        EventV2Bridge.node,
        Truncate.node,
        Agent.node,
        Permission.node,
        InstanceStore.node,
        Session.node,
      ]),
    ),
    servedRoutes.pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
)

describe("patch permission HTTP", () => {
  it.live("lists a pending patch as JSON and an HTTP once reply completes that patch", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: { lsp: false, formatter: false } })
      const instances = yield* InstanceStore.Service
      yield* Effect.addFinalizer(() => instances.disposeDirectory(dir))
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(path.join(dir, "update.txt"), "before\n")
      yield* fs.writeFileString(path.join(dir, "delete.txt"), "obsolete\n")
      yield* fs.writeFileString(path.join(dir, "move.txt"), "old\n")

      yield* Effect.gen(function* () {
        const permission = yield* Permission.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        yield* Effect.addFinalizer(() => sessions.remove(session.id).pipe(Effect.orDie))
        const info = yield* ApplyPatchTool
        const tool = yield* info.init()
        const patch = yield* tool
          .execute(
            {
              patchText:
                "*** Begin Patch\n*** Add File: new.txt\n+created\n*** Update File: update.txt\n@@\n-before\n+after\n*** Delete File: delete.txt\n*** Update File: move.txt\n*** Move to: moved.txt\n@@\n-old\n+new\n*** End Patch",
            },
            {
              sessionID: session.id,
              messageID: MessageID.ascending(),
              agent: "build",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => Effect.void,
              ask: (input) =>
                permission
                  .ask({
                    ...input,
                    sessionID: session.id,
                    ruleset: [{ permission: "edit", pattern: "*", action: "ask" }],
                  })
                  .pipe(Effect.orDie),
            },
          )
          .pipe(Effect.forkScoped)

        const pending = yield* pollWithTimeout(
          permission
            .list()
            .pipe(Effect.map((requests) => requests.find((request) => request.sessionID === session.id))),
          "patch never requested permission",
        )
        expect(yield* fs.exists(path.join(dir, "new.txt"))).toBe(false)
        expect(yield* fs.readFileString(path.join(dir, "update.txt"))).toBe("before\n")
        expect(yield* fs.readFileString(path.join(dir, "delete.txt"))).toBe("obsolete\n")
        expect(yield* fs.readFileString(path.join(dir, "move.txt"))).toBe("old\n")

        const response = yield* HttpClientRequest.get("/permission").pipe(
          HttpClientRequest.setHeader("x-opencode-directory", dir),
          HttpClient.execute,
        )
        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("application/json")
        expect(yield* response.json).toMatchObject([
          {
            id: pending.id,
            sessionID: session.id,
            permission: "edit",
            metadata: {
              files: [
                expect.objectContaining({ type: "add", relativePath: "new.txt" }),
                expect.objectContaining({ type: "update", relativePath: "update.txt" }),
                expect.objectContaining({ type: "delete", relativePath: "delete.txt" }),
                expect.objectContaining({
                  type: "move",
                  relativePath: "moved.txt",
                  movePath: path.join(dir, "moved.txt"),
                }),
              ],
            },
          },
        ])

        const reply = yield* HttpClientRequest.post(`/permission/${pending.id}/reply`).pipe(
          HttpClientRequest.setHeader("x-opencode-directory", dir),
          HttpClientRequest.bodyJson({ reply: "once" }),
          Effect.flatMap(HttpClient.execute),
        )
        expect(reply.status).toBe(200)
        expect(yield* reply.json).toBe(true)
        yield* awaitWithTimeout(Fiber.join(patch), "approved patch did not finish")
        expect(yield* fs.readFileString(path.join(dir, "new.txt"))).toBe("created\n")
        expect(yield* fs.readFileString(path.join(dir, "update.txt"))).toBe("after\n")
        expect(yield* fs.exists(path.join(dir, "delete.txt"))).toBe(false)
        expect(yield* fs.exists(path.join(dir, "move.txt"))).toBe(false)
        expect(yield* fs.readFileString(path.join(dir, "moved.txt"))).toBe("new\n")

        const remaining = yield* HttpClientRequest.get("/permission").pipe(
          HttpClientRequest.setHeader("x-opencode-directory", dir),
          HttpClient.execute,
        )
        expect(remaining.status).toBe(200)
        expect(yield* remaining.json).toEqual([])
      }).pipe(provideInstance(dir))
    }),
  )
})
