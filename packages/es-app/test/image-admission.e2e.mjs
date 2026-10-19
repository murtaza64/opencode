// Usage: bun test/image-admission.e2e.mjs (from packages/es-app).
// IMAGE_ADMISSION_BINARY=/absolute/path verifies a compiled candidate instead of Bun source.
// Starts an isolated backend/database, loopback fake provider and es-app. No live service is used.
import { createRequire } from "node:module"
import http from "node:http"
import net from "node:net"
import { constants } from "node:fs"
import { access, mkdtemp, rm, stat } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { createFixture } from "./composer-fixture.mjs"
import { imageProviderConfig, pngMetadata } from "../../opencode/test/fixture/input-image.ts"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const binary = process.env.IMAGE_ADMISSION_BINARY
if (binary) {
  if (!path.isAbsolute(binary)) throw new Error("IMAGE_ADMISSION_BINARY must be an absolute executable path")
  if (!(await stat(binary)).isFile()) throw new Error("IMAGE_ADMISSION_BINARY must be a file")
  await access(binary, constants.X_OK)
}
const bounded = async (name, promise, milliseconds = 10000) => {
  const timeout = Promise.withResolvers()
  const timer = setTimeout(() => timeout.reject(new Error(`${name} timed out after ${milliseconds}ms`)), milliseconds)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}
const reservePort = async () => {
  const reservation = net.createServer()
  await bounded("port reservation", new Promise((resolve, reject) => {
    reservation.once("error", reject)
    reservation.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve)
  }))
  const port = reservation.address().port
  if (port <= 1024 || [4096, 3181, 7777, 60302].includes(port)) {
    reservation.close()
    throw new Error(`Refusing non-disposable port ${port}`)
  }
  return { port, close: () => bounded("release port", new Promise((resolve) => reservation.close(resolve))) }
}
const backendPort = await reservePort()
const verifyBackendURL = (value) => {
  const url = new URL(value)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "4096" || Number(url.port) !== backendPort.port)
    throw new Error(`Refusing unexpected backend URL ${url.origin}; expected 127.0.0.1:${backendPort.port}`)
  return url.origin
}
expect(() => verifyBackendURL("http://127.0.0.1:4096")).toThrow("Refusing")
expect(() => verifyBackendURL("http://127.0.0.1:7777")).toThrow("Refusing")
const conflictCheck = process.argv.includes("--verify-bind-conflict")
const home = await mkdtemp(`${tmpdir()}/image-admission-`)
const fixture = await createFixture()
const calls = []
const held = []
const provider = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  calls.push(JSON.parse(Buffer.concat(chunks).toString()))
  response.writeHead(200, { "content-type": "text/event-stream" })
  const event = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
    id: "synthetic", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`)
  event({ role: "assistant", content: "Disposable image verification" })
  const finish = () => {
    if (response.writableEnded) return
    event({}, "stop")
    response.end("data: [DONE]\n\n")
  }
  if (calls.length === 1) held.push(finish)
  else finish()
})
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve))
const config = imageProviderConfig(`http://127.0.0.1:${provider.address().port}/v1`)
// Nonzero explicit ports fail on conflict; this server deliberately treats --port 0 as "prefer 4096".
if (!conflictCheck) await backendPort.close()
const command = binary ? [binary] : ["bun", "run", fileURLToPath(new URL("../../opencode/src/index.ts", import.meta.url))]
const backend = Bun.spawn([...command, "serve", "--hostname", "127.0.0.1", "--port", String(backendPort.port)], {
  cwd: home,
  env: {
    ...process.env,
    HOME: home, OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: `${home}/config`, XDG_DATA_HOME: `${home}/data`,
    XDG_STATE_HOME: `${home}/state`, XDG_CACHE_HOME: `${home}/cache`,
    OPENCODE_DB: `${home}/images.sqlite`, OPENCODE_CONFIG: "",
    OPENCODE_CONFIG_DIR: `${home}/config/opencode`, OPENCODE_TEST_MANAGED_CONFIG_DIR: `${home}/managed`,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, server: { hostname: "127.0.0.1", port: backendPort.port, mdns: false } }), OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_PURE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false", OPENCODE_EXPERIMENTAL_EVENT_SYSTEM: "true",
    OPENCODE_SERVER_PASSWORD: "", OPENCODE_PERMISSION: "{}",
  }, stdout: "pipe", stderr: "pipe",
})
let diagnostics = ""
const stderr = (async () => {
  for await (const chunk of backend.stderr) diagnostics = (diagnostics + new TextDecoder().decode(chunk)).slice(-8192)
})()
let output = ""
const ready = Promise.withResolvers()
const stdout = (async () => {
  for await (const chunk of backend.stdout) {
    output = (output + new TextDecoder().decode(chunk)).slice(-8192)
    const match = output.match(/listening on (http:\/\/[^\s]+)/)
    if (match) ready.resolve(match[1])
  }
  ready.reject(new Error("Backend exited before ready"))
})()
let vite
let browser
const frontendSockets = new Set()
let stage = "startup"
const run = async () => {
  if (conflictCheck) {
    expect(await bounded("conflicting backend exit", backend.exited, 30000)).not.toBe(0)
    await bounded("backend output", Promise.all([stdout, stderr]))
    expect(output).not.toContain("listening on")
    expect(diagnostics).toContain("ServeError")
    console.log(`PASS explicit backend port ${backendPort.port} refuses bind conflict without falling back to 4096`)
    return
  }
  const base = verifyBackendURL(await bounded("backend startup", ready.promise, 30000))
  console.log(`ISOLATION backendPID=${backend.pid} requestedPort=${backendPort.port} reportedURL=${base} executable=${binary ?? "bun-source"}`)
  if (process.argv.includes("--verify-failure-cleanup")) throw new Error("Injected failure before any HTTP request")
  stage = "HTTP setup"
  const api = async (path, body) => {
    const response = await fetch(`${base}${path}?directory=${encodeURIComponent(home)}`, {
      method: body ? "POST" : "GET", headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    })
    expect(response.status, path).toBeLessThan(300)
    return response.status === 204 ? undefined : response.json()
  }
  const session = await api("/session", { title: "Disposable metadata screenshot", agent: "build", model: { id: "test-model", providerID: "test" } })
  await api(`/session/${session.id}/prompt_async`, { agent: "build", model: { providerID: "test", modelID: "test-model" }, parts: [{ type: "text", text: "Synthetic local work only" }] })
  await expect.poll(() => held.length).toBe(1)
  process.env.OPENCODE_URL = base
  process.env.ES_DASHBOARD_URL = fixture.url
  const frontendPort = await reservePort()
  await frontendPort.close()
  vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { host: "127.0.0.1", port: frontendPort.port, strictPort: true } })
  vite.httpServer.on("connection", (socket) => {
    frontendSockets.add(socket)
    socket.once("close", () => frontendSockets.delete(socket))
  })
  await bounded("frontend startup", vite.listen())
  expect(vite.httpServer.address().port).toBe(frontendPort.port)
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, channel: "chrome", timeout: 15000 })
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(15000)
  stage = "browser attachment admission"
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url())
    if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) return route.continue()
    errors.push(`Unexpected external request ${url.origin}`)
    return route.abort()
  })
  await page.goto(`${origin}/session/${session.id}?directory=${encodeURIComponent(home)}`)
  const active = page.locator(".prompt-box:not([inert])")
  const editor = active.getByRole("textbox", { name: "Message", exact: true })
  const original = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AH8A//8E/gJ++9d/DQAAAABJRU5ErkJggg=="
  const images = ["zTXt", "iTXt"].map((type) => ({ mime: "image/png", filename: `${type}.png`, url: pngMetadata(original, type) }))
  const paste = async () => {
    await editor.evaluate((el, images) => {
      const data = new DataTransfer()
      for (const image of images) data.items.add(new File([Uint8Array.from(atob(image.url.split(",")[1]), (char) => char.charCodeAt(0))], image.filename, { type: image.mime }))
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }))
    }, images)
    await expect(active.getByRole("button", { name: /^Remove / })).toHaveCount(2)
  }
  for (const delivery of ["Queue", "Steer"]) {
    await paste()
    await editor.fill(`Synthetic ${delivery}`)
    const admitted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/session/${session.id}/input`))
    await active.getByRole("button", { name: delivery, exact: true }).click()
    const response = await admitted
    expect(await bounded("admission response body", response.text())).not.toContain("BadRequest")
    expect(response.status()).toBe(200)
    const body = response.request().postDataJSON()
    expect(body.delivery).toBe(delivery.toLowerCase())
    expect(body.images.map((image) => image.url)).toEqual(images.map((image) => image.url))
    await expect(editor).toHaveValue("")
    await expect(active.getByRole("button", { name: /^Remove / })).toHaveCount(0)
  }
  // Genuine server rejection, not an intercepted/fabricated HTTP response.
  stage = "genuine rejection and reload retention"
  const patched = await fetch(`${base}/session/${session.id}?directory=${encodeURIComponent(home)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: { providerID: "test", modelID: "text-only" } }), signal: AbortSignal.timeout(10000) })
  expect(patched.status).toBe(200)
  expect(await patched.json()).toMatchObject({ preferredModel: { id: "text-only" } })
  await paste()
  await editor.fill("Retain this draft on rejection")
  for (const delivery of ["Queue", "Steer"]) {
    const rejected = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/session/${session.id}/input`))
    await active.getByRole("button", { name: delivery, exact: true }).click()
    expect((await rejected).status()).toBe(400)
    await expect(editor).toHaveValue("Retain this draft on rejection")
    await expect(active.getByRole("button", { name: /^Remove / })).toHaveCount(2)
  }
  await page.reload()
  await expect(editor).toHaveValue("Retain this draft on rejection")
  await expect(active.getByRole("button", { name: /^Remove / })).toHaveCount(2)
  const receipts = await api(`/session/${session.id}/input`)
  expect(receipts.items).toHaveLength(2)
  stage = "fake provider image verification"
  held[0]()
  await expect.poll(() => calls.length, { timeout: 30000 }).toBe(3)
  expect(JSON.stringify(calls[1]).split(original)).toHaveLength(3)
  expect(JSON.stringify(calls[2]).split(original)).toHaveLength(5)
  expect(JSON.stringify(calls)).not.toContain(images[0].url)
  expect(JSON.stringify(calls)).not.toContain(images[1].url)
  expect(errors).toEqual([])
  console.log("PASS real es-app attachment paste → HTTP queue/steer200, exact original metadata bytes, 2 receipts/4 images, stripped byte-exact PNG provider payloads, genuine400 draft+attachments retained across reload; isolated fake provider calls=3")
}
// A rejected readiness promise is expected in the deliberate bind-conflict check.
ready.promise.catch(() => {})
try {
  await bounded("complete image admission scenario", run(), 90000)
} catch (error) {
  console.error(`FAIL stage=${stage}`, error, `\nbackend stdout:\n${output}\nbackend stderr:\n${diagnostics}`)
  process.exitCode = 1
} finally {
  // Kill our backend before UI shutdown: sockets/stream drains must not hold it open indefinitely.
  held.forEach((finish) => finish())
  backend.kill()
  await bounded("backend SIGTERM exit", backend.exited, 5000).catch(async () => {
    backend.kill("SIGKILL")
    await bounded("backend SIGKILL exit", backend.exited, 5000)
  })
  if (conflictCheck) await backendPort.close()
  await bounded("browser close", browser?.close(), 5000).catch((error) => {
    console.error("FAIL bounded cleanup", error)
    process.exitCode = 1
  })
  // Vite's HTTP close can wait on event-mux upgrades; destroy only this test's sockets.
  frontendSockets.forEach((socket) => socket.destroy())
  provider.closeAllConnections()
  const cleanup = await Promise.allSettled([
    bounded("frontend close", vite?.close(), 5000),
    bounded("provider close", new Promise((resolve) => provider.close(resolve)), 5000),
    bounded("dashboard fixture close", fixture.close(), 5000),
    bounded("backend pipe drain", Promise.all([stdout, stderr]), 5000),
  ])
  for (const result of cleanup) {
    if (result.status !== "rejected") continue
    console.error("FAIL bounded cleanup", result.reason)
    process.exitCode = 1
  }
  await bounded("temporary state removal", rm(home, { recursive: true, force: true }), 5000)
  console.log(`CLEANUP backendPID=${backend.pid} exited; disposable state removed`)
  // Exit even if a timed-out browser/dev-server close left a process-local socket open.
  process.exit(process.exitCode ?? 0)
}
