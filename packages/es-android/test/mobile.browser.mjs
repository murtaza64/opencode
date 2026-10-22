// Headless phone-sized check of the paired gateway: pairing, session list,
// transcript, draft durability across a gateway outage, reconnect, and send.
// Uses a private fixture; no daemon, model provider, or production service.
import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { createRequire } from "node:module"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture, directory } from "../../es-app/test/composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const root = fileURLToPath(new URL("..", import.meta.url))
const artifacts = path.join(root, "dist/artifacts")
await mkdir(artifacts, { recursive: true })
const code = "TEST2-PAIR3-CODE4-ONLY5"
const port = await new Promise((resolve) => {
  const probe = net.createServer().listen(0, "127.0.0.1", () => {
    const value = probe.address().port
    probe.close(() => resolve(value))
  })
})
const origin = `http://127.0.0.1:${port}`
const fixture = await createFixture()
fixture.status = "idle"
fixture.permissions = []
fixture.mail = (_, lane) => ({ editspace: "fixture", lane, messages: [] })
fixture.sessionTimes.set("ses_a", { created: Date.now() - 60_000, updated: Date.now() - 30_000 })
fixture.messages = [
  {
    info: { id: "msg_1", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: 1 } },
    parts: [{ id: "part_1", messageID: "msg_1", sessionID: "ses_a", type: "text", text: "Fixture question from the host." }],
  },
  {
    info: {
      id: "msg_2", parentID: "msg_1", sessionID: "ses_a", role: "assistant", agent: "build", mode: "build",
      providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, time: { created: 2, completed: 3 },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: "part_2", messageID: "msg_2", sessionID: "ses_a", type: "text", text: "Fixture answer rendered on the phone." }],
  },
]

let gateway
const gatewayOutput = []
const startGateway = async () => {
  gateway = spawn("bun", ["src/gateway.ts", "--port", String(port)], {
    cwd: root,
    env: { ...process.env, OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, ES_REMOTE_PAIRING_CODE: code, OPENCODE_SERVER_PASSWORD: "" },
    stdio: ["ignore", "pipe", "inherit"],
  })
  await new Promise((resolve, reject) => {
    gateway.once("exit", (status) => reject(new Error(`Gateway exited ${status}`)))
    gateway.stdout.on("data", (chunk) => {
      gatewayOutput.push(String(chunk))
      if (String(chunk).includes("Editspace gateway")) resolve()
    })
  })
}
const stopGateway = async () => {
  if (gateway.exitCode !== null || gateway.signalCode !== null) return
  const exited = new Promise((resolve) => gateway.once("exit", resolve))
  gateway.kill("SIGTERM")
  await exited
}
const pass = (text) => console.info(`PASS ${text}`)

await startGateway()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 15; wv) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36 EditspaceAndroid/0.1",
})
let page = await context.newPage()
const sessionURL = `${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
const textarea = () => page.locator("textarea:visible").first()
const status = () => page.locator(".session-work-status")
const draftKey = `es-app:composer:1:${JSON.stringify(["ses_a", directory])}`

try {
  await page.goto(origin)
  await expect(page.getByRole("heading", { name: "Pair this device" })).toBeVisible()
  await page.fill("#code", "WRONG-CODE")
  await page.getByRole("button", { name: "Pair" }).click()
  await expect(page.getByRole("alert")).toContainText("does not match")
  expect((await context.cookies()).some((cookie) => cookie.name === "es_remote")).toBe(false)
  await page.fill("#code", code.toLowerCase().replaceAll("-", " "))
  await page.getByRole("button", { name: "Pair" }).click()
  await page.waitForURL(`${origin}/`)
  const cookie = (await context.cookies()).find((item) => item.name === "es_remote")
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict" })
  pass("wrong code is refused; right code pairs with an HttpOnly SameSite=Strict cookie")

  await page.getByText("Composer fixture").first().click()
  await page.waitForURL(/\/session\/ses_a/)
  await expect(page.getByText("Fixture answer rendered on the phone.")).toBeVisible()
  await expect(status()).toHaveAttribute("data-state", "idle")
  await page.screenshot({ path: path.join(artifacts, "mobile-session.png") })
  pass("session list opens the transcript over the gateway")

  for (const dir of ["ltr", "rtl"]) {
    await page.evaluate((value) => { document.documentElement.dir = value }, dir)
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: innerWidth }))
    expect(width.scroll).toBeLessThanOrEqual(width.view)
    const box = await textarea().boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
  }
  await page.evaluate(() => { document.documentElement.dir = "ltr" })
  pass("session page has no horizontal overflow at 390px in LTR and RTL")

  const draft = "Draft typed on the phone"
  await textarea().fill(draft)
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key) ?? "", draftKey)).toContain(draft)
  await stopGateway()
  await expect(status()).toHaveAttribute("data-state", "disconnected", { timeout: 15_000 })
  await page.screenshot({ path: path.join(artifacts, "mobile-disconnected.png") })
  await expect(textarea()).toHaveValue(draft)
  pass("gateway outage shows disconnected and keeps the draft in place")

  await startGateway()
  await expect(status()).toHaveAttribute("data-state", "idle", { timeout: 20_000 })
  await expect(textarea()).toHaveValue(draft)
  pass("live page reconnects after the gateway restarts without re-pairing")

  // Android may destroy the WebView page while backgrounded; a new page has no sessionStorage.
  await stopGateway()
  await page.close()
  page = await context.newPage()
  expect(await page.goto(sessionURL).catch(() => null)).toBeNull()
  await startGateway()
  await page.goto(sessionURL)
  await expect(page.getByText("Fixture answer rendered on the phone.")).toBeVisible()
  await expect(textarea()).toHaveValue(draft)
  pass("draft survives page recreation during an outage (durable storage for the Android shell)")

  await expect(status()).toHaveAttribute("data-state", "idle", { timeout: 20_000 })
  const sends = () => fixture.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/prompt_async")
  await textarea().press("Control+Enter")
  await expect.poll(() => sends().length).toBe(1)
  expect(JSON.stringify(sends()[0].body)).toContain(draft)
  await expect(textarea()).toHaveValue("")
  await page.screenshot({ path: path.join(artifacts, "mobile-sent.png") })
  pass("send reaches the host through the gateway and clears the draft")
  expect(fixture.unexpected).toEqual([])
  expect(gatewayOutput.join("")).not.toContain(code)
  pass("gateway output never contains the pairing code")
} finally {
  await browser.close()
  await stopGateway().catch(() => undefined)
  await fixture.close()
}
