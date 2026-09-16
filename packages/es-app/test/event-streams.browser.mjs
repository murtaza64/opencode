import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { build, createServer, preview } from "vite"
import { WebSocket } from "ws"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, firefox, expect } = createRequire(new URL("../../app/package.json", import.meta.url))(
  "@playwright/test",
)
const protocol = "opencode-events-v1"
const root = fileURLToPath(new URL("..", import.meta.url))
const cleanups = []
try {
  const fixture = await createFixture()
  cleanups.push(() => fixture.close())
  fixture.status = "idle"
  fixture.messages = []
  fixture.permissions = []
  process.env.OPENCODE_URL = process.env.ES_DASHBOARD_URL = fixture.url
  const dev = await createServer({ root, server: { host: "127.0.0.1", port: 0 } })
  cleanups.push(() => dev.close())
  await dev.listen()
  const scratch = await mkdtemp(path.join(os.tmpdir(), "opencode-event-mux-"))
  cleanups.push(() => rm(scratch, { recursive: true, force: true }))
  await build({ root, logLevel: "error", build: { outDir: path.join(scratch, "dist") } })
  const built = await preview({
    root,
    build: { outDir: path.join(scratch, "dist") },
    preview: { host: "127.0.0.1", port: 0 },
  })
  cleanups.push(
    () =>
      new Promise((resolve) => {
        built.httpServer.closeAllConnections()
        built.httpServer.close(resolve)
      }),
  )
  const origins = [
    ["dev", `http://127.0.0.1:${dev.httpServer.address().port}`],
    ["preview", `http://127.0.0.1:${built.httpServer.address().port}`],
  ]
  if (process.argv.includes("--serve")) {
    console.log(
      JSON.stringify({
        preview: `${origins[1][1]}/session/ses_a?directory=${encodeURIComponent(directory)}`,
        scenario: "Open a second tab for the same origin; both use synthetic services",
      }),
    )
    await new Promise((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop)
        process.off("SIGTERM", stop)
        resolve()
      }
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
    })
  } else {
    const browser = await (process.env.BROWSER === "firefox"
      ? firefox.launch({ headless: true })
      : chromium.launch({ headless: true, channel: "chrome" }))
    cleanups.push(() => browser.close())
    const publish = (pathname, data, id = "") => {
      for (const [response, stream] of fixture.eventStreams)
        if (stream.path === pathname) response.write(`${id ? `id: ${id}\n` : ""}data: ${data}\n\n`)
    }
    for (const [mode, origin] of origins) {
      const context = await browser.newContext()
      try {
        const pages = [await context.newPage(), await context.newPage()]
        const sockets = []
        pages.forEach((page) =>
          page.on("websocket", (socket) => {
            if (/\/(oc\/global\/event|es\/api\/notification-events)$/.test(new URL(socket.url()).pathname))
              sockets.push(socket)
          }),
        )
        await pages[0].goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
        await expect.poll(() => fixture.eventStreams.size).toBe(4)
        await pages[1].goto(`${origin}/session/ses_b?directory=${encodeURIComponent(directory)}`)
        await expect.poll(() => fixture.eventStreams.size).toBe(8)
        expect([...fixture.eventStreams.values()].map((stream) => stream.path).sort()).toEqual([
          "/api/events",
          "/api/events",
          "/api/notification-events",
          "/api/notification-events",
          "/event",
          "/event",
          "/global/event",
          "/global/event",
        ])
        await expect(pages[0].locator(".topbar")).toContainText("Composer fixture")
        await expect(pages[1].locator(".topbar")).toContainText("Other session")
        expect(sockets).toHaveLength(4)
        const results = await Promise.all(
          pages.map((page) =>
            page.evaluate(async (directory) => {
              const start = performance.now()
              const status = await fetch(`/oc/session/status?directory=${encodeURIComponent(directory)}`)
              const submission = await fetch(
                `/oc/session/ses_b/prompt_async?directory=${encodeURIComponent(directory)}`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ parts: [{ type: "text", text: "synthetic transport check" }] }),
                },
              )
              return {
                status: status.status,
                submission: submission.status,
                elapsedMs: Math.round(performance.now() - start),
              }
            }, directory),
          ),
        )
        expect(results.map((result) => [result.status, result.submission])).toEqual([
          [200, 204],
          [200, 204],
        ])
        const info = {
          id: "msg_mux",
          sessionID: "ses_a",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "fixture", modelID: "test" },
        }
        const part = {
          id: "prt_mux",
          messageID: info.id,
          sessionID: info.sessionID,
          type: "text",
          text: "MUX_SENTINEL Ω 🦊\nsecond line",
        }
        fixture.messages = [{ info, parts: [part] }]
        fixture.emit("message.updated", { info })
        fixture.emit("message.part.updated", { part })
        await expect(pages[0].locator(".transcript")).toContainText("MUX_SENTINEL Ω 🦊")
        await expect(pages[1].locator(".transcript")).not.toContainText("MUX_SENTINEL")
        const infoB = { ...info, id: "msg_mux_b", sessionID: "ses_b" }
        const partB = {
          ...part,
          id: "prt_mux_b",
          messageID: infoB.id,
          sessionID: "ses_b",
          text: "SECOND_SESSION_SENTINEL",
        }
        fixture.messagesB = [{ info: infoB, parts: [partB] }]
        fixture.emit("message.updated", { info: infoB })
        fixture.emit("message.part.updated", { part: partB })
        await expect(pages[1].locator(".transcript")).toContainText("SECOND_SESSION_SENTINEL")
        await expect(pages[0].locator(".transcript")).not.toContainText("SECOND_SESSION_SENTINEL")
        const gate = {
          id: "perm_mux",
          sessionID: "ses_b",
          permission: "bash",
          patterns: ["GLOBAL_GATE_SENTINEL"],
          always: [],
          metadata: {},
        }
        const gateA = { ...gate, id: "perm_mux_a", sessionID: "ses_a", patterns: ["FIRST_GATE_SENTINEL"] }
        fixture.permissions = [gateA, gate]
        publish(
          "/global/event",
          JSON.stringify({ directory, payload: { type: "permission.asked", properties: gateA } }),
          "global-0",
        )
        publish(
          "/global/event",
          JSON.stringify({ directory, payload: { type: "permission.asked", properties: gate } }),
          "global-1",
        )
        await expect(pages[0].locator(".session-alerts")).toContainText("FIRST_GATE_SENTINEL")
        await expect(pages[1].locator(".session-alerts")).toContainText("GLOBAL_GATE_SENTINEL")
        const stateReads = fixture.calls.filter((call) => call.path === "/api/state").length
        const notificationReads = fixture.calls.filter((call) => call.path === "/api/notifications").length
        publish("/api/events", "changed")
        publish("/api/notification-events", "changed")
        await expect
          .poll(() => fixture.calls.filter((call) => call.path === "/api/state").length)
          .toBeGreaterThanOrEqual(stateReads + 2)
        await expect
          .poll(() => fixture.calls.filter((call) => call.path === "/api/notifications").length)
          .toBeGreaterThanOrEqual(notificationReads + 2)
        const eventReads = fixture.calls.filter((call) => call.path === "/event").length
        fixture.disconnect()
        await expect
          .poll(() => fixture.calls.filter((call) => call.path === "/event").length, { timeout: 10000 })
          .toBeGreaterThan(eventReads)
        await expect.poll(() => fixture.eventStreams.size).toBe(8)
        await expect(pages[0].locator(".topbar")).not.toContainText("disconnected")
        await expect(pages[0].locator(".transcript")).toContainText("MUX_SENTINEL")
        await expect(pages[1].locator(".transcript")).toContainText("SECOND_SESSION_SENTINEL")
        await expect(pages[0].locator(".session-alerts")).toContainText("FIRST_GATE_SENTINEL")
        await expect(pages[1].locator(".session-alerts")).toContainText("GLOBAL_GATE_SENTINEL")
        if (mode === "dev") {
          const relay = dev.config.plugins.find((plugin) => plugin.name === "es-app:event-proxy")
          const beforeSockets = sockets.length
          const beforeStreams = fixture.calls.filter((call) =>
            ["/event", "/global/event", "/api/events", "/api/notification-events"].includes(call.path),
          ).length
          await relay.closeBundle()
          relay.configureServer(dev)
          await expect.poll(() => sockets.length, { timeout: 10000 }).toBeGreaterThanOrEqual(beforeSockets + 4)
          await expect
            .poll(
              () =>
                fixture.calls.filter((call) =>
                  ["/event", "/global/event", "/api/events", "/api/notification-events"].includes(call.path),
                ).length,
              { timeout: 10000 },
            )
            .toBeGreaterThanOrEqual(beforeStreams + 8)
          await expect.poll(() => fixture.eventStreams.size, { timeout: 10000 }).toBe(8)
          await expect(pages[0].locator(".topbar")).not.toContainText("disconnected")
          await expect(pages[1].locator(".topbar")).not.toContainText("disconnected")
          await expect(pages[0].locator(".transcript")).toContainText("MUX_SENTINEL")
          await expect(pages[1].locator(".session-alerts")).toContainText("GLOBAL_GATE_SENTINEL")
        }
        const activeSockets = sockets.filter((socket) => !socket.isClosed()).length
        expect(activeSockets).toBe(4)
        await pages[0].locator('.sidebar a[href*="/session/ses_b"]').first().click()
        await expect(pages[0].locator(".topbar")).toContainText("Other session")
        await expect.poll(() => fixture.eventStreams.size).toBe(8)
        await pages[0].locator('.sidebar a[href*="/session/ses_a"]').first().click()
        await expect(pages[0].locator(".topbar")).toContainText("Composer fixture")
        await expect.poll(() => fixture.eventStreams.size).toBe(8)
        await pages[0].close()
        await expect.poll(() => fixture.eventStreams.size).toBe(4)
        console.log(
          JSON.stringify({
            mode,
            browser: browser.browserType().name(),
            pages: 2,
            upstreamStreams: 8,
            browserSockets: activeSockets,
            results,
            scopedAndGlobalEvents: "passed",
            reconnect: "passed",
          }),
        )
      } finally {
        await context.close()
      }
      await expect.poll(() => fixture.eventStreams.size).toBe(0)
      fixture.messages = []
      fixture.messagesB = []
      fixture.permissions = []
    }
    const origin = origins[0][1]
    const wsURL = origin.replace("http:", "ws:") + "/oc/global/event"
    const foreign = new WebSocket(wsURL, protocol, { origin: "https://foreign.invalid" })
    cleanups.push(() => foreign.terminate())
    const rejected = await new Promise((resolve) => {
      foreign.on("error", () => {})
      foreign.once("open", () => resolve(101))
      foreign.once("unexpected-response", (_request, response) => {
        response.resume()
        resolve(response.statusCode)
        foreign.terminate()
      })
    })
    expect(rejected).toBe(403)
    fixture.eventAuthorization = `Basic ${randomBytes(24).toString("base64")}`
    for (const authorized of [false, true]) {
      const socket = new WebSocket(wsURL, protocol, {
        origin,
        headers: authorized ? { authorization: fixture.eventAuthorization } : {},
      })
      cleanups.push(() => socket.terminate())
      socket.on("error", () => {})
      const result = new Promise((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()))))
      await new Promise((resolve) => socket.once("open", resolve))
      socket.send(JSON.stringify({ type: "subscribe", id: 1, url: "/oc/global/event" }))
      expect(await result).toMatchObject(authorized ? { id: 1, type: "open" } : { id: 1, type: "error", code: 401 })
      socket.close()
      await expect.poll(() => fixture.eventStreams.size).toBe(0)
    }
    fixture.eventAuthorization = undefined
    const scoped = new WebSocket(origin.replace("http:", "ws:") + "/es/api/notification-events", protocol, { origin })
    cleanups.push(() => scoped.terminate())
    const packets = []
    scoped.on("error", () => {})
    scoped.on("message", (data) => packets.push(JSON.parse(data.toString())))
    await new Promise((resolve) => scoped.once("open", resolve))
    scoped.send(JSON.stringify({ type: "subscribe", id: 11, url: "/es/api/events?es=alpha%20%26%20tools" }))
    scoped.send(JSON.stringify({ type: "subscribe", id: 12, url: "/es/api/events?es=beta" }))
    await expect.poll(() => packets.filter((packet) => packet.type === "open").length).toBe(2)
    expect([...fixture.eventStreams.values()].map((stream) => stream.es).sort()).toEqual(["alpha & tools", "beta"])
    for (const [response, stream] of fixture.eventStreams)
      if (stream.es === "beta") response.write("data: beta-update\n\n")
    await expect
      .poll(() => packets.filter((packet) => packet.data === "beta-update").map((packet) => packet.id))
      .toEqual([12])
    const closed = new Promise((resolve) => scoped.once("close", (code) => resolve(code)))
    scoped.send(JSON.stringify({ type: "subscribe", id: 13, url: "/oc/global/event" }))
    expect(await closed).toBe(1008)
    await expect.poll(() => fixture.eventStreams.size).toBe(0)
    const { serve } = await dev.ssrLoadModule(fileURLToPath(new URL("../../es-desktop/src/server.ts", import.meta.url)))
    const native = await serve({ root: path.join(scratch, "dist"), opencode: fixture.url, dashboard: fixture.url })
    cleanups.push(() => native.close())
    const nativeContext = await browser.newContext({
      userAgent: "Mozilla/5.0 Electron/40.0",
      extraHTTPHeaders: { "x-editspace-key": native.key },
    })
    try {
      const page = await nativeContext.newPage()
      const sockets = []
      page.on("websocket", (socket) => sockets.push(socket.url()))
      await page.goto(`${native.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
      await expect(page.locator(".topbar")).toContainText("Composer fixture")
      await expect.poll(() => fixture.eventStreams.size).toBe(4)
      expect(sockets).toEqual([])
      const nativeInfo = {
        id: "msg_native",
        sessionID: "ses_a",
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "fixture", modelID: "test" },
      }
      const nativePart = {
        id: "prt_native",
        messageID: nativeInfo.id,
        sessionID: "ses_a",
        type: "text",
        text: "NATIVE_FEED_SENTINEL",
      }
      fixture.messages = [{ info: nativeInfo, parts: [nativePart] }]
      fixture.emit("message.updated", { info: nativeInfo })
      fixture.emit("message.part.updated", { part: nativePart })
      await expect(page.locator(".transcript")).toContainText("NATIVE_FEED_SENTINEL")
      const nativeGate = {
        id: "perm_native",
        sessionID: "ses_a",
        permission: "bash",
        patterns: ["NATIVE_GATE_SENTINEL"],
        always: [],
        metadata: {},
      }
      fixture.permissions = [nativeGate]
      publish(
        "/global/event",
        JSON.stringify({ directory, payload: { type: "permission.asked", properties: nativeGate } }),
      )
      await expect(page.locator(".session-alerts")).toContainText("NATIVE_GATE_SENTINEL")
      const denied = await fetch(`${native.origin}/oc/session/status`)
      expect(denied.status).toBe(403)
      await denied.body?.cancel()
      console.log(JSON.stringify({ nativeServerFallback: "passed", unauthorized: 403, websocketConnections: 0 }))
    } finally {
      await nativeContext.close()
    }
    await expect.poll(() => fixture.eventStreams.size).toBe(0)
  }
} finally {
  await Promise.allSettled(cleanups.map((close) => Promise.resolve().then(close)))
}
