// The desk chat never stays on "Loading chat…": with no home pointer (404) it loads this device's desk or offers
// Start chat; a host read that hangs still loads after its bound; an unreachable Work host that was never the home
// is ignored; a home with no desk yet offers Start chat. Disposable fixture only.
// Run from packages/es-app: node test/desk-load-states.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const open = async ({ pointer, devicePointer, host }) => {
  preview.fixture.pointer = pointer
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
  await context.addInitScript((value) => { if (window === window.top && value) localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) }, devicePointer)
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  if (host === "hang") await page.route("**/__es/host", () => undefined)
  if (host === "work-mini-down") {
    await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Laptop", remote: false, hosts: [], work: [{ id: "mini", label: "Mac Mini", origin: "https://mini.example.ts.net" }] } }))
    await page.route("**/hosts/mini/**", (route) => route.fulfill({ status: 502, body: "{}" }))
  }
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 120_000 })
  return { chat: page.locator(".desk-companion"), close: () => context.close() }
}
const cases = [
  ["404 pointer, device desk", { devicePointer: { session: "ses_a", directory } }, "chat"],
  ["404 pointer, no device desk", {}, "start"],
  ["host read hangs, device desk", { devicePointer: { session: "ses_a", directory }, host: "hang" }, "chat"],
  ["Work host unreachable, never home", { devicePointer: { session: "ses_a", directory }, host: "work-mini-down" }, "chat"],
  ["home with no desk yet", { pointer: { home: true, revision: 0, none: true } }, "start"],
]
try {
  for (const [name, setup, expected] of cases) {
    const view = await open(setup)
    if (expected === "chat") await expect(view.chat.locator(".desk-chat textarea"), name).toBeVisible({ timeout: 90_000 })
    else await expect(view.chat.getByRole("button", { name: "Start chat" }), name).toBeVisible({ timeout: 90_000 })
    await expect(view.chat.getByText("Loading chat…"), name).toHaveCount(0)
    await view.close()
    console.log(`${name}: ${expected}`)
  }
  console.log("PASS desk-load-states")
} catch (error) {
  console.error("FAIL desk-load-states", error)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close?.()
  process.exit(process.exitCode ?? 0)
}
