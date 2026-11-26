// Inline entity refs (chip design P1, DD #364/#371). In an agent's markdown: a Surface link becomes a text-height token
// (board glyph + current title; stale dot when the Surface moved past the linked revision; dashed '?' when missing; host
// glyph for another Work host), a decision link shows its current state, a known @mention (persona or lane) becomes an
// avatar + name token, an unknown @name stays text, and code is never tokenised. Hover and keyboard focus show the
// card; Enter opens; the phone width shows the card as a bottom sheet; RTL keeps tokens isolated.
// Run from packages/es-app: node test/entity-refs.browser.mjs   (SCREENSHOT_DIR=<dir>)
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-entity-refs")
mkdirSync(shots, { recursive: true })
const preview = await startAttentionPreview()
const fixture = preview.fixture
fixture.status = "idle"
const now = Date.now()
fixture.surfaces = [{ id: "decision-briefs", title: "Decision briefs", summary: "21 cases across desktop, phone, glasses and push", kind: "path", owner: "desktop-delivery", lane: "ux-feel",
  editspace: "fixture", updated_at: now - 300_000, revision: 3, health: { state: "ok" } }]
fixture.personas = [{ name: "Ferry", owner_lane: "fixture/es-app-mini" }]
const text = [
  "Updated [Decision briefs](/?surface=decision-briefs) and the older [briefs rev 2](/?surface=decision-briefs&rev=2).",
  "The [old board](/?surface=old-board) is gone; [Visuals](/hosts/mini/__es/surface/visuals) lives on the Mini.",
  "Waiting on [the scope](/?item=attention:fixture:decision_1). @Ferry please look; @nobody is not an agent.",
  "Run `open /?surface=decision-briefs @Ferry` literally.",
  "Catch-up is in [catchup](?item=mini~surface%3Adiff-stream-catchup-20261103).",
].join("\n\n")
fixture.messages = [
  { info: { id: "msg_u", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: now - 60_000 } },
    parts: [{ id: "prt_u", messageID: "msg_u", sessionID: "ses_a", type: "text", text: "status?" }] },
  { info: { id: "msg_a", parentID: "msg_u", sessionID: "ses_a", role: "assistant", agent: "build", mode: "build", providerID: "fixture", modelID: "test",
    path: { cwd: directory, root: directory }, time: { created: now - 50_000, completed: now - 49_000 }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [{ id: "prt_a", messageID: "msg_a", sessionID: "ses_a", type: "text", text }] },
]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(30_000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
    { id: "local", label: "Local", origin: preview.origin }, { id: "mini", label: "Mac Mini", origin: "https://mini.example.ts.net" }] } }))
  await page.goto(`${preview.url}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  const message = page.locator('[data-find-message="msg_a"]')
  await expect(message).toContainText("Updated", { timeout: 120_000 })
  const surface = message.locator('.eref.s').filter({ hasText: "Decision briefs" })
  await expect(surface).toHaveCount(2, { timeout: 30_000 })
  // Current title, not the link text; the older link is marked stale.
  await expect(surface.first()).toHaveAttribute("aria-label", "Surface: Decision briefs, revision 3")
  await expect(surface.nth(1)).toHaveAttribute("aria-label", /r2 pinned; r3 latest/)
  await expect(surface.nth(1).locator(".emk.warn")).toHaveCount(1)
  await expect(message.locator(".eref.s.missing")).toHaveAttribute("aria-label", "Surface: old board, not found on this host (withdrawn or never published there)")
  await expect(message.locator(".eref.s").filter({ hasText: "Visuals" }).locator(".eh")).toHaveCount(1)
  // Decision: live state.
  const decision = message.locator(".eref.d")
  await expect(decision).toHaveAttribute("data-s", "open")
  await expect(decision).toHaveText(/Choose the bounded implementation scope/)
  // Mentions: known persona becomes a token, unknown stays text, code untouched.
  const ferry = message.locator(".eref.m").filter({ hasText: "Ferry" })
  await expect(ferry).toHaveCount(1)
  await expect(ferry.locator(".av")).toHaveText("F")
  await expect(message).toContainText("@nobody is not an agent")
  await expect(message.locator("code .eref")).toHaveCount(0)
  await expect(message.locator("code").first()).toHaveText("open /?surface=decision-briefs @Ferry")
  // A query-only link (no leading slash) to another host's Surface: a Surface token on that host, opening the desk reader.
  const catchup = message.locator(".eref.s").filter({ hasText: "catchup" })
  await expect(catchup.locator(".eh")).toHaveCount(1)
  expect(await catchup.getAttribute("href")).toBe("/?item=mini~surface%3Adiff-stream-catchup-20261103")
  // Avatar at r4 size: 1.15em of the token text.
  const ratio = await ferry.evaluate((el) => el.querySelector(".av").getBoundingClientRect().width / parseFloat(getComputedStyle(el).fontSize))
  expect(ratio).toBeGreaterThan(1.05)
  expect(ratio).toBeLessThan(1.25)
  // Card on hover and on keyboard focus; never offers to answer.
  await surface.first().hover()
  const card = page.locator(".eref-card")
  await expect(card).toContainText("rev 3")
  await expect(card).toContainText("desktop-delivery")
  await page.screenshot({ path: join(shots, "hover.png") })
  await page.mouse.move(0, 0)
  await ferry.focus()
  await expect(card).toContainText("es-app-mini")
  await decision.focus()
  await expect(card).toContainText("never answered from here")
  // Enter opens the decision.
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/item=attention(%3A|:)fixture(%3A|:)decision_1/)
  // Phone (touch): a bottom sheet over everything, touch wording, grab handle; RTL keeps tokens isolated.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  await phone.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
    { id: "local", label: "Local", origin: preview.origin }, { id: "mini", label: "Mac Mini", origin: "https://mini.example.ts.net" }] } }))
  const mobile = await phone.newPage()
  mobile.on("pageerror", (error) => errors.push(error.message))
  await mobile.goto(`${preview.url}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await mobile.evaluate(() => { document.documentElement.dir = "rtl" })
  const phoneSurface = mobile.locator('[data-find-message="msg_a"] .eref.s').filter({ hasText: "Decision briefs" }).first()
  await expect(phoneSurface).toBeVisible({ timeout: 120_000 })
  await phoneSurface.focus()
  const phoneCard = mobile.locator(".eref-card")
  await expect(phoneCard).toContainText("Tap to open · swipe down to close")
  await expect(phoneCard.locator(".eref-card-grab")).toBeVisible()
  const placed = await phoneCard.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const top = document.elementFromPoint(box.left + box.width / 2, box.bottom - 6)
    return { bottom: Math.round(innerHeight - box.bottom), onTop: el.contains(top), full: box.left <= 1 && box.right >= innerWidth - 1 }
  })
  expect(placed).toEqual({ bottom: 0, onTop: true, full: true })
  expect(await phoneSurface.evaluate((el) => getComputedStyle(el).unicodeBidi)).toBe("isolate")
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await mobile.screenshot({ path: join(shots, "rtl-390.png") })
  await phone.close()
  expect(errors).toEqual([])
  console.log(`PASS entity refs: Surface (current title, stale dot, missing dashed, other-host glyph), decision (live state), known @mention token, unknown @name text, code untouched; card on hover and focus; Enter opens; phone bottom sheet; RTL isolate; screenshots ${shots}`)
} finally {
  await preview.close()
  await browser.close()
}
