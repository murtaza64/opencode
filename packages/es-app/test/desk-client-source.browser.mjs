// Every Desk send carries one lower-trust "sent from" part: client, device label, profile, destination session and
// client time, from first-party labels only (no user agent). Disposable fixture only.
// Run from packages/es-app: node test/desk-client-source.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const fixture = preview.fixture
fixture.inputContext = true
const browser = await chromium.launch({ channel: "chrome", headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
  await context.addInitScript((value) => { if (window === window.top) localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) }, { session: "ses_a", directory })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "laptop", label: "Laptop", remote: false, hosts: [], work: [], profile: "work" } }))
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 120_000 })
  const chat = page.locator(".desk-companion")
  const editor = chat.locator(".prompt-box").getByRole("textbox", { name: "Message", exact: true })
  await expect(editor).toBeVisible({ timeout: 90_000 })
  await editor.fill("where did this come from")
  await chat.locator(".prompt-box").getByRole("button", { name: /^(Steer|Send)$/ }).first().click()
  const sent = () => fixture.calls.find((call) => call.method === "POST" && /^\/session\/ses_a\/(input|prompt_async)$/.test(call.path) && JSON.stringify(call.body).includes("where did this come from"))
  await expect.poll(() => !!sent(), { timeout: 30_000 }).toBe(true)
  const body = JSON.stringify(sent().body)
  expect(body).toContain("es-app/client")
  expect(body).toContain("client: Editspace web app")
  expect(body).toContain("device: Laptop")
  expect(body).toContain("profile: work")
  expect(body).toContain("session ses_a")
  expect(body).toMatch(/client sent: \d{4}-\d\d-\d\dT/)
  expect(body).not.toContain("Mozilla/")
  console.log("PASS desk-client-source")
} catch (error) {
  console.error("FAIL desk-client-source", error)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close?.()
  process.exit(process.exitCode ?? 0)
}
