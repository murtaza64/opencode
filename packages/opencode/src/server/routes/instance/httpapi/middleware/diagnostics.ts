import { Diagnostics } from "@opencode-ai/core/diagnostics"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

/** Times every HTTP handler until its response is produced (streams count until headers). */
export const diagnosticsTimingLayer = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const id = Diagnostics.requestStart(new URL(request.url, "http://localhost").pathname)
      return yield* effect.pipe(Effect.ensuring(Effect.sync(() => Diagnostics.requestEnd(id))))
    }),
  { global: true },
)

const ProfileBody = Schema.Struct({ seconds: Schema.optional(Schema.Number), label: Schema.optional(Schema.String) })

/**
 * `GET /global/diagnostics` and `POST /global/diagnostics/profile`, outside the public API. Both need the
 * local diagnostics token (see `Diagnostics.localToken`) in addition to the server's normal authorization.
 */
export const diagnosticsRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const guard = <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (!(yield* Effect.promise(() => Diagnostics.authorized(request.headers[Diagnostics.TOKEN_HEADER]))))
          return HttpServerResponse.jsonUnsafe({ error: "diagnostics token required" }, { status: 403 })
        if (!Diagnostics.enabled())
          return HttpServerResponse.jsonUnsafe({ error: "diagnostics are disabled (OPENCODE_DIAGNOSTICS=0)" }, { status: 409 })
        return yield* handler
      })
    yield* router.add("GET", "/global/diagnostics", guard(Effect.sync(() => HttpServerResponse.jsonUnsafe(Diagnostics.snapshot()))))
    yield* router.add(
      "POST",
      "/global/diagnostics/profile",
      guard(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const body = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ProfileBody)),
            Effect.orElseSucceed(() => ({ seconds: undefined, label: undefined })),
          )
          return yield* Effect.tryPromise(() => Diagnostics.profile({ seconds: body.seconds ?? 30, label: body.label })).pipe(
            Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
            Effect.catch((error) =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  { error: error.cause instanceof Error ? error.cause.message : String(error) },
                  { status: error.cause instanceof Diagnostics.ProfileBusy ? 409 : 500 },
                ),
              ),
            ),
          )
        }),
      ),
    )
  }),
)
