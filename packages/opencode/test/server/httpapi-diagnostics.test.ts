import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Diagnostics } from "@opencode-ai/core/diagnostics"
import { Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { ServerAuth } from "../../src/server/auth"
import { authorizationRouterMiddleware } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import {
  diagnosticsRoute,
  diagnosticsTimingLayer,
} from "../../src/server/routes/instance/httpapi/middleware/diagnostics"
import { testEffect } from "../lib/effect"

const serve = (password: Option.Option<string>) =>
  HttpRouter.serve(
    Layer.mergeAll(
      diagnosticsRoute,
      HttpRouter.use((router) => router.add("GET", "/slow", Effect.sleep("50 millis").pipe(Effect.as(HttpServerResponse.text("ok"))))),
    ).pipe(
      Layer.provide(authorizationRouterMiddleware.layer),
      Layer.provide(diagnosticsTimingLayer),
      Layer.provide(ServerAuth.Config.configLayer({ password, username: "opencode" })),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const open = testEffect(serve(Option.none()))
const secured = testEffect(serve(Option.some("pw")))

afterEach(() => Diagnostics.stop())

const get = (headers: Record<string, string>) =>
  HttpClientRequest.get("/global/diagnostics").pipe(HttpClientRequest.setHeaders(headers), HttpClient.execute)

describe("diagnostics routes", () => {
  open.live("refuse requests without the local diagnostics token", () =>
    Effect.gen(function* () {
      Diagnostics.start()
      expect((yield* get({})).status).toBe(403)
      expect((yield* get({ [Diagnostics.TOKEN_HEADER]: "wrong" })).status).toBe(403)
    }),
  )

  open.live("serve a snapshot that includes timed requests", () =>
    Effect.gen(function* () {
      Diagnostics.start()
      yield* HttpClientRequest.get("/slow").pipe(HttpClient.execute)
      const token = yield* Effect.promise(() => Diagnostics.localToken())
      const response = yield* get({ [Diagnostics.TOKEN_HEADER]: token })
      expect(response.status).toBe(200)
      const body = (yield* response.json) as unknown as ReturnType<typeof Diagnostics.snapshot>
      const slow = body.requests.routes.find((row) => row.key === "/slow")
      expect(slow?.n).toBe(1)
      expect(slow!.maxMs).toBeGreaterThanOrEqual(40)
      expect(body.meta.pid).toBe(process.pid)
    }),
  )

  open.live("report diagnostics disabled when collection never started", () =>
    Effect.gen(function* () {
      const token = yield* Effect.promise(() => Diagnostics.localToken())
      expect((yield* get({ [Diagnostics.TOKEN_HEADER]: token })).status).toBe(409)
    }),
  )

  open.live("reject a second concurrent profile", () =>
    Effect.gen(function* () {
      Diagnostics.start()
      const token = yield* Effect.promise(() => Diagnostics.localToken())
      const post = HttpClientRequest.post("/global/diagnostics/profile").pipe(
        HttpClientRequest.setHeaders({ [Diagnostics.TOKEN_HEADER]: token }),
        HttpClientRequest.bodyJsonUnsafe({ seconds: 1, label: "route" }),
        HttpClient.execute,
      )
      const [first, second] = yield* Effect.all([post, Effect.sleep("100 millis").pipe(Effect.andThen(post))], {
        concurrency: 2,
      })
      expect([first.status, second.status].toSorted()).toEqual([200, 409])
      const result = (yield* (first.status === 200 ? first : second).json) as unknown as Diagnostics.ProfileResult
      expect(result.file).toEndWith("-route.cpuprofile")
    }),
  )

  secured.live("still require server authorization when a password is set", () =>
    Effect.gen(function* () {
      Diagnostics.start()
      const token = yield* Effect.promise(() => Diagnostics.localToken())
      expect((yield* get({ [Diagnostics.TOKEN_HEADER]: token })).status).toBe(401)
      const basic = `Basic ${Buffer.from("opencode:pw").toString("base64")}`
      expect((yield* get({ [Diagnostics.TOKEN_HEADER]: token, authorization: basic })).status).toBe(200)
    }),
  )
})
