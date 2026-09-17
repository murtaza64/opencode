import http from "node:http"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { build, createServer, preview } from "vite"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, firefox, expect } = createRequire(new URL("../../app/package.json", import.meta.url))(
  "@playwright/test",
)
const cleanups = []
try {
  const fixture = await createFixture()
  cleanups.push(() => fixture.close())
  const credential = `Basic ${Buffer.from(`fixture:${randomBytes(24).toString("hex")}`).toString("base64")}`
  const denied = JSON.stringify({ error: "Authentication required" })
  const upstream = http.createServer((request, response) => {
    const pathname = new URL(request.url, fixture.url).pathname
    if (["/session/ses_a", "/event", "/api/state"].includes(pathname) && request.headers.authorization !== credential) {
      response.writeHead(401, {
        "www-authenticate": 'Basic realm="fixture"',
        "content-type": "application/json",
        "x-fixture": "protected",
      })
      response.end(denied)
      return
    }
    if (pathname === "/forbidden") {
      response.writeHead(403, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "Forbidden" }))
      return
    }
    const proxy = http.request(
      new URL(request.url, fixture.url),
      { method: request.method, headers: request.headers },
      (result) => {
        response.writeHead(result.statusCode, result.headers)
        result.pipe(response)
        response.on("close", () => result.destroy())
      },
    )
    proxy.on("error", () => {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
    request.pipe(proxy)
  })
  cleanups.push(
    () =>
      new Promise((resolve) => {
        upstream.closeAllConnections()
        upstream.close(() => resolve())
      }),
  )
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const upstreamURL = `http://127.0.0.1:${upstream.address().port}`
  process.env.OPENCODE_URL = process.env.ES_DASHBOARD_URL = upstreamURL
  const root = fileURLToPath(new URL("..", import.meta.url))
  const scratch = await mkdtemp(path.join(tmpdir(), "opencode-auth-proxy-"))
  cleanups.push(() => rm(scratch, { recursive: true, force: true }))
  const dev = await createServer({ root, server: { host: "127.0.0.1", port: 0 } })
  cleanups.push(() => dev.close())
  await dev.listen()
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
        built.httpServer.close(() => resolve())
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
        scenario: "Synthetic protected upstream; expected HTTP 401 application error",
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
    const browser = await (process.env.AUTH_BROWSER === "firefox"
      ? firefox.launch({ headless: true })
      : chromium.launch({ headless: true, channel: "chrome" }))
    cleanups.push(() => browser.close())
    const baseline = process.env.AUTH_EXPECT_CHALLENGE === "1"
    const direct = await fetch(`${upstreamURL}/session/ses_a`)
    expect(direct.status).toBe(401)
    expect(/^Basic\b/.test(direct.headers.get("www-authenticate") ?? "")).toBe(true)
    await direct.body?.cancel()
    for (const [mode, origin] of origins) {
      for (const pathname of ["/oc/session/ses_a", "/oc/event", "/es/api/state"]) {
        const response = await fetch(`${origin}${pathname}`)
        console.log(
          JSON.stringify({
            mode,
            path: pathname,
            status: response.status,
            challengePresent: response.headers.has("www-authenticate"),
          }),
        )
        expect(response.status).toBe(401)
        expect(response.headers.has("www-authenticate")).toBe(baseline)
        expect(response.headers.get("x-fixture")).toBe("protected")
        expect(await response.text()).toBe(denied)
        const authorized = await fetch(`${origin}${pathname}`, { headers: { Authorization: credential } })
        expect(authorized.status).toBe(200)
        await authorized.body?.cancel()
      }
      const forbidden = await fetch(`${origin}/oc/forbidden`)
      expect(forbidden.status).toBe(403)
      await forbidden.body?.cancel()
      const context = await browser.newContext()
      try {
        if (process.env.AUTH_BROWSER === "firefox")
          await context.route("**/*", (route) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
          )
        const page = await context.newPage()
        let streamRejected = false
        page.on("websocket", (socket) =>
          socket.on("framereceived", ({ payload }) => {
            if (!["/oc/global/event", "/es/api/notification-events"].includes(new URL(socket.url()).pathname)) return
            if (typeof payload !== "string") return
            const packet = JSON.parse(payload)
            if (packet.type === "error" && packet.code === 401) streamRejected = true
          }),
        )
        const challenges = []
        const cdp = process.env.AUTH_BROWSER === "firefox" ? undefined : await context.newCDPSession(page)
        if (cdp) {
          cdp.on(
            "Fetch.requestPaused",
            (event) =>
              void (new URL(event.request.url).origin === origin
                ? cdp.send("Fetch.continueRequest", { requestId: event.requestId })
                : cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" })),
          )
          cdp.on("Fetch.authRequired", (event) => {
            challenges.push({ path: new URL(event.request.url).pathname, scheme: event.authChallenge.scheme })
            void cdp.send("Fetch.continueWithAuth", {
              requestId: event.requestId,
              authChallengeResponse: { response: "CancelAuth" },
            })
          })
          await cdp.send("Fetch.enable", { handleAuthRequests: true })
        }
        const responses = ["/oc/session/ses_a", "/es/api/state"].map((pathname) =>
          page.waitForResponse(
            (response) => new URL(response.url()).pathname === pathname && response.status() === 401,
          ),
        )
        await Promise.all([
          page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`),
          ...responses,
        ])
        await expect(page.getByRole("alert").filter({ hasText: "HTTP 401" }).first()).toBeVisible({ timeout: 30000 })
        await expect.poll(() => streamRejected).toBe(true)
        if (cdp)
          expect([...new Set(challenges.map((challenge) => challenge.path))].sort()).toEqual(
            baseline ? ["/es/api/state", "/oc/session/ses_a"] : [],
          )
        console.log(
          JSON.stringify({
            mode,
            browser: browser.browserType().name(),
            applicationError: 401,
            authenticationChallenges: cdp ? challenges : null,
          }),
        )
      } finally {
        await context.close()
      }
    }
  }
} finally {
  const results = await Promise.allSettled(cleanups.map((close) => Promise.resolve().then(close)))
  if (results.some((result) => result.status === "rejected")) throw new Error("Auth proxy fixture cleanup failed")
}
