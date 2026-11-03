// A Front Desk on a host that became the Work desk's home after the page loaded: (1) its own conversation is offered,
// and "Use this conversation" claims the home pointer with that same session (reason create, no second desk);
// (2) a desk started on a page that loaded before the home was turned on still claims the pointer.
// Disposable fixture only. Run from packages/es-app: node test/desk-home-claim.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const fixture = preview.fixture
const browser = await chromium.launch({ channel: "chrome", headless: true })
const created = () => fixture.calls.filter((call) => call.method === "POST" && call.path === "/session")
const open = async (pointer) => {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
  await context.addInitScript((value) => { if (window === window.top && value && !sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) } }, pointer)
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 120_000 })
  return { page, close: () => context.close() }
}
try {
  // 1. Home turned on; this host already has its own conversation (ses_a): offered, then claimed as the same session.
  fixture.pointer = { home: true, revision: 0, none: true }
  const one = await open({ session: "ses_a", directory })
  const chat = one.page.locator(".desk-companion")
  await expect(chat.getByRole("button", { name: "Use this conversation" })).toBeVisible({ timeout: 90_000 })
  await chat.getByRole("button", { name: "Use this conversation" }).click()
  await expect(chat.locator(".desk-chat textarea")).toBeVisible({ timeout: 30_000 })
  expect(fixture.pointer).toMatchObject({ revision: 1, session: "ses_a", reason: "create" })
  expect(created(), "claiming never creates a session").toHaveLength(0)
  await one.close()
  console.log("CLAIM: own conversation ses_a became the Work desk, revision 1, no session created")

  // 2. Page loaded while this host was not the home; the home is turned on before Start chat.
  fixture.pointer = undefined
  const two = await open(undefined)
  const desk = two.page.locator(".desk-companion")
  await expect(desk.getByRole("button", { name: "Start chat" })).toBeVisible({ timeout: 90_000 })
  fixture.pointer = { home: true, revision: 0, none: true }
  await desk.getByRole("button", { name: "Start chat" }).click()
  await expect.poll(() => fixture.pointer?.revision, { timeout: 30_000 }).toBe(1)
  expect(created()).toHaveLength(1)
  expect(fixture.pointer.session).toBe(created()[0].body.id)
  await two.close()
  console.log("LATE HOME: started desk claimed the pointer with its own session id")
  console.log("PASS desk-home-claim")
} catch (error) {
  console.error("FAIL desk-home-claim", error)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close?.()
  process.exit(process.exitCode ?? 0)
}
