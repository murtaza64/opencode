// Ask about this (ATTN-17). On a local decision card and on a Mac Mini decision card, Ask about this opens the Front
// desk chat and adds that decision as a chip (host, id, revision, label) to the chat's CURRENT draft: the text
// already typed stays, the @label is appended, the caret lands after it. Nothing is sent, answered or notified:
// no message/input POST, no attention command on either host. Keyboard (Enter on the button) and RTL.
// Run from packages/es-app: node test/ask-about.browser.mjs   (SCREENSHOT_DIR=<dir>)
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-ask-about")
mkdirSync(shots, { recursive: true })
const preview = await startAttentionPreview()
preview.ledger.operator = true
const fixture = preview.fixture
fixture.status = "idle"
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
const miniOrigin = "http://127.0.0.1:65032"
const miniDir = "/Users/mini/fixture"
const now = Date.now()
const miniDecision = { id: "decision_m", editspace: "fixture", revision: 4, content_revision: 3, status: "open", kind: "decision", title: "Rotate the Mini certs?", context: "The Mini's TLS certs expire Friday.",
  options: [{ id: "now", label: "Rotate now" }, { id: "later", label: "Next week" }], producer_session: "ses_m", origin_session: "ses_m", gate_key: "mini:certs", source_ref: { session_id: "ses_m", directory: miniDir },
  decision: null, delivery_state: "not-requested", created_at: now - 60_000, updated_at: now - 60_000, snoozed_until: null }
const miniWrites = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  // The Front desk chat is a ready session (ses_b), docked open on this page.
  await context.addInitScript(value => { try { localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)); localStorage.setItem("es-app:companion:work", "1") } catch {} }, { session: "ses_b", directory })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route(url => { const u = new URL(url); return u.origin !== preview.origin && u.origin !== miniOrigin }, route => route.abort())
  await page.route("**/__es/host", route => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
    { id: "local", label: "Local", origin: fixture.url }, { id: "mini", label: "Mac Mini", origin: miniOrigin }] } }))
  await page.route(`${miniOrigin}/**`, route => route.fulfill({ contentType: "text/html", body: "<title>Mini</title>" }))
  await page.route("**/hosts/mini/**", async route => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (method !== "GET") miniWrites.push(`${method} ${url.pathname}`)
    const path = url.pathname.replace(/^\/hosts\/mini/, "")
    if (path === "/oc/experimental/session") return route.fulfill({ json: [{ id: "ses_m", title: "Mini worker", directory: miniDir, time: { created: 1, updated: now } }] })
    if (path === "/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: `${miniDir}/.editspace` }], default: "fixture" } })
    if (path === "/es/api/attention" && method === "GET") return route.fulfill({ json: { records: [miniDecision], projects: [{ editspace: "fixture", available: true }], partial: false, limit: 200 } })
    if (path === "/es/api/attention/session") return route.fulfill({ json: { operator: true, answer: true } })
    if (path === `/es/api/attention/${miniDecision.id}`) return route.fulfill({ json: { record: miniDecision, events: [] } })
    return route.fulfill({ json: [] })
  })
  const chat = page.locator(".desk-companion")
  const editor = chat.getByRole("textbox", { name: "Message", exact: true })
  const chips = () => page.evaluate(() => JSON.parse(localStorage.getItem("es-app:context-refs:ses_b") ?? "[]"))
  const caret = () => editor.evaluate((el) => [el.selectionStart, el.selectionEnd, el.value.length])

  // Local decision: a draft is typed in the chat, then the chat is closed.
  await page.goto(`${preview.url}/?item=${encodeURIComponent("attention:fixture:decision_1")}`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const detail = page.locator(".desk-evidence[aria-label='Selected item']")
  const ask = detail.getByRole("button", { name: "Ask about this" })
  await expect(ask).toBeVisible({ timeout: 120_000 })
  await expect(editor).toBeVisible({ timeout: 60_000 })
  await editor.fill("Before deciding,")
  await chat.getByRole("button", { name: "Close Porter" }).click()
  await expect(chat).toHaveClass(/closed/)
  await ask.click()
  await expect(chat).not.toHaveClass(/closed/)
  await expect(editor).toHaveValue("Before deciding, @Choose the bounded implementation scope ")
  await expect(editor).toBeFocused()
  // Caret at the end of the draft, right after the appended label.
  expect(await caret()).toEqual(["Before deciding, @Choose the bounded implementation scope ".length, "Before deciding, @Choose the bounded implementation scope ".length, "Before deciding, @Choose the bounded implementation scope ".length])
  expect(await chips()).toEqual([expect.objectContaining({ kind: "decision", id: "decision_1", host: new URL(preview.url).host, editspace: "fixture", revision: 1,
    label: "Choose the bounded implementation scope" })])
  await expect(detail.getByRole("status").filter({ hasText: "Added to the chat draft." })).toBeVisible()
  await page.screenshot({ path: join(shots, "local.png") })

  // Mini decision, by keyboard: the chip names the Mini and its content revision; the draft keeps everything so far.
  await page.goto(`${preview.url}/?item=${encodeURIComponent("mini~attention:fixture:decision_m")}`, { waitUntil: "domcontentloaded" })
  const remote = page.locator(".work-remote")
  const remoteAsk = remote.getByRole("button", { name: "Ask about this" })
  await expect(remoteAsk).toBeVisible({ timeout: 120_000 })
  await remoteAsk.focus()
  await page.keyboard.press("Enter")
  await expect(editor).toHaveValue("Before deciding, @Choose the bounded implementation scope @Rotate the Mini certs? ")
  await expect(editor).toBeFocused()
  const all = await chips()
  expect(all.map((ref) => [ref.host, ref.id, ref.revision])).toEqual([[new URL(preview.url).host, "decision_1", 1], ["mini", "decision_m", 3]])
  await page.screenshot({ path: join(shots, "mini.png") })

  // RTL: same behavior, no overflow.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await editor.fill("سؤال:")
  await remoteAsk.click()
  await expect(editor).toHaveValue("سؤال: @Rotate the Mini certs? ")
  expect((await chips()).length).toBe(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(shots, "rtl.png") })

  // Nothing was sent or answered anywhere.
  const sends = fixture.calls.filter((call) => call.method === "POST" && /\/session\/[^/]+\/(message|prompt_async|input)/.test(call.path))
  expect(sends).toEqual([])
  expect(preview.ledger.calls.filter((call) => call.method !== "GET" && call.path !== "/api/attention/session")).toEqual([])
  expect(miniWrites.filter((write) => !write.endsWith("/attention/session"))).toEqual([])
  expect(errors).toEqual([])
  console.log(`PASS ask about this: local and Mini decision cards add a host-qualified decision chip (id, revision, label) to the Front desk chat's current draft, text kept, label appended, caret after it, chat opened and focused; keyboard; RTL; nothing sent, answered or notified on either host; screenshots ${shots}`)
} finally {
  await preview.close()
  await browser.close()
}
