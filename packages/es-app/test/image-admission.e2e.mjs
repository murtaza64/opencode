// Usage: bun test/image-admission.e2e.mjs (from packages/es-app).
// Starts an isolated backend/database, loopback fake provider and es-app. No live service is used.
import { createRequire } from "node:module"
import { createServer as createHttpServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { createFixture } from "./composer-fixture.mjs"
import { imageProviderConfig, pngMetadata } from "../../opencode/test/fixture/input-image.ts"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const home = await mkdtemp(`${tmpdir()}/image-admission-`)
const fixture = await createFixture()
const calls = []
const held = []
const provider = createHttpServer(async (request, response) => {
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
const backend = Bun.spawn(["bun", "run", fileURLToPath(new URL("../../opencode/src/index.ts", import.meta.url)), "serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: home,
  env: {
    ...process.env,
    HOME: home, OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: `${home}/config`, XDG_DATA_HOME: `${home}/data`,
    XDG_STATE_HOME: `${home}/state`, XDG_CACHE_HOME: `${home}/cache`,
    OPENCODE_DB: `${home}/images.sqlite`, OPENCODE_CONFIG: "",
    OPENCODE_CONFIG_DIR: `${home}/config/opencode`, OPENCODE_TEST_MANAGED_CONFIG_DIR: `${home}/managed`,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_PURE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false", OPENCODE_EXPERIMENTAL_EVENT_SYSTEM: "true",
    OPENCODE_SERVER_PASSWORD: "", OPENCODE_PERMISSION: "{}",
  }, stdout: "pipe", stderr: "pipe",
})
const diagnostics = new Response(backend.stderr).text()
let output = ""
const ready = (async () => {
  for await (const chunk of backend.stdout) {
    output += new TextDecoder().decode(chunk)
    const match = output.match(/listening on (http:\/\/[^\s]+)/)
    if (match) return match[1]
  }
  throw new Error(`Backend exited before ready: ${await diagnostics}`)
})()
let vite
let browser
try {
  const base = await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("Backend startup timeout")), 30000).unref())])
  const api = async (path, body) => {
    const response = await fetch(`${base}${path}?directory=${encodeURIComponent(home)}`, {
      method: body ? "POST" : "GET", headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    expect(response.status, path).toBeLessThan(300)
    return response.status === 204 ? undefined : response.json()
  }
  const session = await api("/session", { title: "Disposable metadata screenshot", agent: "build", model: { id: "test-model", providerID: "test" } })
  await api(`/session/${session.id}/prompt_async`, { agent: "build", model: { providerID: "test", modelID: "test-model" }, parts: [{ type: "text", text: "Synthetic local work only" }] })
  await expect.poll(() => held.length).toBe(1)
  process.env.OPENCODE_URL = base
  process.env.ES_DASHBOARD_URL = fixture.url
  vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { host: "127.0.0.1", port: 0 } })
  await vite.listen()
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, channel: "chrome" })
  const page = await browser.newPage()
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
    expect(await response.text()).not.toContain("BadRequest")
    expect(response.status()).toBe(200)
    const body = response.request().postDataJSON()
    expect(body.delivery).toBe(delivery.toLowerCase())
    expect(body.images.map((image) => image.url)).toEqual(images.map((image) => image.url))
    await expect(editor).toHaveValue("")
    await expect(active.getByRole("button", { name: /^Remove / })).toHaveCount(0)
  }
  // Genuine server rejection, not an intercepted/fabricated HTTP response.
  const patched = await fetch(`${base}/session/${session.id}?directory=${encodeURIComponent(home)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: { providerID: "test", modelID: "text-only" } }) })
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
  held[0]()
  await expect.poll(() => calls.length, { timeout: 30000 }).toBe(3)
  expect(JSON.stringify(calls[1]).split(original)).toHaveLength(3)
  expect(JSON.stringify(calls[2]).split(original)).toHaveLength(5)
  expect(JSON.stringify(calls)).not.toContain(images[0].url)
  expect(JSON.stringify(calls)).not.toContain(images[1].url)
  expect(errors).toEqual([])
  console.log("PASS real es-app attachment paste → HTTP queue/steer200, exact original metadata bytes, 2 receipts/4 images, stripped byte-exact PNG provider payloads, genuine400 draft+attachments retained across reload; isolated fake provider calls=3")
  if (process.env.IMAGE_ADMISSION_PREVIEW === "1") {
    console.log(`PREVIEW ${origin}/session/${session.id}?directory=${encodeURIComponent(home)}\nSTOP kill ${process.pid}`)
    await new Promise((resolve) => {
      process.once("SIGTERM", resolve)
      process.once("SIGINT", resolve)
    })
  }
} finally {
  held.forEach((finish) => finish())
  await browser?.close()
  await vite?.close()
  backend.kill()
  await backend.exited
  provider.closeAllConnections()
  await new Promise((resolve) => provider.close(resolve))
  await fixture.close()
  await rm(home, { recursive: true, force: true })
}
