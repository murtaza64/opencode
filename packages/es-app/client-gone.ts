import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http"

/**
 * Runs `stop` once when the response is over: it finished, or the client went away mid-stream.
 */
export const onClientGone = (req: IncomingMessage, res: ServerResponse, stop: () => void) => {
  // Bun's node:http emits no response "close" when the client disconnects. It does close an unread request
  // (see sendRequestBody); a request read to its end also closes, but that only means its body is done.
  const socket = req.socket
  const requestClosed = () => {
    if (!req.readableEnded) fire()
  }
  const release = () => {
    res.off("close", fire)
    socket.off("close", fire)
    req.off("close", requestClosed)
  }
  const fire = () => {
    release()
    stop()
  }
  res.once("close", fire)
  socket.once("close", fire)
  req.once("close", requestClosed)
}

/**
 * Forwards the request body upstream. A GET or HEAD has none, so the request is left unread: once Bun's
 * node:http has read a request to its end it reports no disconnect at all, and a proxied SSE would then hold
 * its upstream socket until the idle timeout.
 */
export const sendRequestBody = (req: IncomingMessage, upstream: ClientRequest) => {
  if (req.method === "GET" || req.method === "HEAD") return void upstream.end()
  req.pipe(upstream)
}
