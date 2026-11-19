import { IncomingMessage } from "node:http"
import { Effect, Stream } from "effect"
import { HttpServerRequest } from "effect/unstable/http"

export const untilDisconnected = Effect.gen(function* () {
  const { source } = yield* HttpServerRequest.HttpServerRequest
  if (!(source instanceof IncomingMessage)) return <A, E, R>(stream: Stream.Stream<A, E, R>) => stream
  const socket = source.socket
  // Bun's Node HTTP compatibility layer does not reliably interrupt the request
  // fiber on response close. An active HTTP/1 SSE body owns its socket until EOF.
  const closed = Effect.callback<void>((resume) => {
    if (socket.destroyed) return resume(Effect.void)
    const close = () => resume(Effect.void)
    socket.once("close", close)
    return Effect.sync(() => { socket.off("close", close) })
  })
  return <A, E, R>(stream: Stream.Stream<A, E, R>) => stream.pipe(Stream.interruptWhen(closed))
})
