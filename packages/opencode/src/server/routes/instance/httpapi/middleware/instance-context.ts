import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext") {}

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

const promptAsyncPath = /^\/session\/[^/]+\/prompt_async$/

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext | HttpServerRequest.HttpServerRequest> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const directory = decode(route.directory)
    const request = yield* HttpServerRequest.HttpServerRequest
    const pathname = new URL(request.url, "http://localhost").pathname
    if (request.method === "GET" && ["/session/status", "/permission", "/question"].includes(pathname)) {
      const cached = yield* store.peek(directory)
      if (!cached) return HttpServerResponse.jsonUnsafe(pathname === "/session/status" ? {} : [])
    }
    // Listing is DB-only; resolve project identity without pinning an Instance.
    const listing = request.method === "GET" && ["/session", "/umbrella/session"].includes(pathname)
    // Session create and prompt_async only persist durable rows, so they start the
    // Instance boot and answer once the project identity resolves instead of waiting
    // for bootstrap. The forked model turn behind prompt_async waits for the ready Instance.
    const admitting = request.method === "POST" && (pathname === "/session" || promptAsyncPath.test(pathname))
    const ctx = listing
      ? yield* store.resolve(directory)
      : admitting
        ? yield* store.start({ directory })
        : yield* store.load({ directory })
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store))
  }),
)
