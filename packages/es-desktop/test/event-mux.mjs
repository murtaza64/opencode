// Run after: bun build ./src/server.ts --target=node --format=esm --outfile=dist/server-test.mjs
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { serve } from "../dist/server-test.mjs"

const root = await mkdtemp(path.join(tmpdir(), "es-mux-test-"))
await writeFile(path.join(root, "index.html"), "<title>decoy</title>")
const upstream = createServer((req, res) => {
  if (!["/event", "/global/event", "/api/events", "/api/notification-events"].includes(new URL(req.url, "http://localhost").pathname)) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { "content-type": "text/event-stream" })
  res.write(`id: 7\ndata: ${new URL(req.url, "http://localhost").pathname}\n\n`)
})
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`
const server = await serve({ root, opencode: upstreamOrigin, dashboard: upstreamOrigin })
const wsUrl = (pathname) => `${server.origin.replace("http:", "ws:")}${pathname}`
const auth = { origin: server.origin, "x-editspace-key": server.key }
const connect = (pathname, headers = auth) => new WebSocket(wsUrl(pathname), "opencode-events-v1", { headers })
const opened = (socket) => new Promise((resolve, reject) => {
  socket.once("open", resolve)
  socket.once("error", reject)
})
const denied = (socket) => new Promise((resolve, reject) => {
  socket.once("unexpected-response", (_req, res) => { resolve(res.statusCode); res.resume() })
  socket.once("open", () => reject(new Error("Unauthorized upgrade succeeded")))
  socket.once("error", reject)
})
try {
  assert.deepEqual(await (await fetch(`${server.origin}/__es/events`, { headers: { "x-editspace-key": server.key } })).json(), { protocol: "opencode-events-v1" })
  for (const headers of [
    { origin: server.origin },
    { origin: "https://evil.test", "x-editspace-key": server.key },
    { ...auth, host: "evil.test" },
    { ...auth, "sec-fetch-site": "cross-site" },
  ]) assert.equal(await denied(connect("/oc/global/event", headers)), 403)
  assert.equal(await denied(connect("/oc/global/event?query=1")), 403)
  assert.equal(await denied(connect("/oc/pty")), 403)
  const socket = connect("/oc/global/event")
  await opened(socket)
  const packets = []
  const received = new Promise((resolve) => socket.on("message", (data) => {
    const packet = JSON.parse(data.toString())
    packets.push(packet)
    if (packets.filter((value) => value.type === "message").length === 2) resolve()
  }))
  socket.send(JSON.stringify({ type: "subscribe", id: 1, url: "/oc/event?directory=%2Ffixture" }))
  socket.send(JSON.stringify({ type: "subscribe", id: 2, url: "/oc/global/event" }))
  await received
  assert.deepEqual(packets.filter((value) => value.type === "message"), [
    { id: 1, type: "message", data: "/event", lastEventId: "7" },
    { id: 2, type: "message", data: "/global/event", lastEventId: "7" },
  ])
  socket.close()
  await new Promise((resolve) => socket.once("close", resolve))
  const next = connect("/es/api/notification-events")
  await opened(next)
  const notification = new Promise((resolve) => next.on("message", (data) => {
    const packet = JSON.parse(data.toString())
    if (packet.type === "message") resolve(packet)
  }))
  next.send(JSON.stringify({ type: "subscribe", id: 3, url: "/es/api/notification-events" }))
  assert.deepEqual(await notification, { id: 3, type: "message", data: "/api/notification-events", lastEventId: "7" })
  next.close()
  await new Promise((resolve) => next.once("close", resolve))
  console.log("PASS protected event mux: scoped/global/dashboard delivery, reconnect, origin/key/host/query denial")
} finally {
  await server.close()
  await new Promise((resolve) => upstream.close(resolve))
  await rm(root, { recursive: true, force: true })
}
