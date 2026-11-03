// A decision attached to a Surface keeps its card across attention refreshes (DD surface-decision-focus-compact-drawing):
// typing 200+ characters while 20 snapshots arrive keeps the text, the caret and focus; an IME composition survives a
// refresh; leaving and coming back keeps the draft. Refreshes are the app's own 30 s poll, driven by a fake clock, and
// each snapshot carries changed records. Disposable fixture. Run from packages/es-app.
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const now = Date.now()
const record = { id: "board_1", editspace: "fixture", revision: 1, status: "open", kind: "decision", title: "Board r7: develop or park?", context: "Develop or park?",
  options: [{ id: "develop", label: "Develop" }, { id: "park", label: "Park" }], producer_session: "ses_a", origin_session: "ses_a", gate_key: "board_1:v1",
  source_ref: { session_id: "ses_a", directory }, decision: null, delivery_state: "not-requested", created_at: now - 60_000, updated_at: now - 60_000, snoozed_until: null,
  artifact: { title: "Board", surface: "board", revision: 7 } }
preview.ledger.operator = true
preview.fixture.permissions = []
preview.ledger.cloudLanes = []
preview.ledger.records = [record]
preview.fixture.surfaces = [{ id: "board", title: "Board", summary: null, kind: "path", owner: "ux-feel", lane: "ux-feel", editspace: "fixture", updated_at: now, created_at: now,
  revision: 7, purpose: "deliverable", seen: true, health: { state: "ok", checked_at: now, last_ok_at: now } }]

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", error => errors.push(error.message))
const snapshots = () => preview.ledger.calls.filter(call => call.method === "GET" && /^\/?$/.test(call.path)).length
// One snapshot from the app's own poll, with this record changed so every record object is new.
const refresh = async (step) => {
  const before = snapshots()
  record.updated_at = now + step
  preview.ledger.records = [{ ...record }]
  await page.clock.runFor(31_000)
  await expect.poll(snapshots).toBeGreaterThan(before)
}
try {
  await page.clock.install({ time: now })
  await page.goto(`${preview.url}/?surface=board`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const card = page.getByRole("complementary", { name: "Decision about this" }).locator('article.home-decision[data-attention-id="board_1"]')
  await expect(card.getByRole("button", { name: /^Develop/ })).toBeVisible({ timeout: 120_000 })
  // Marks the mounted card; a remount would drop the mark.
  await card.evaluate(el => { el.dataset.probe = "mounted" })
  await card.getByRole("button", { name: "Type something…" }).click()
  const field = card.getByRole("textbox", { name: "Your answer" })
  await expect(field).toBeFocused()

  let typed = ""
  for (let step = 1; step <= 20; step++) {
    const chunk = `chunk ${String(step).padStart(2, "0")} of the answer `
    await page.keyboard.type(chunk)
    typed += chunk
    await refresh(step)
    await expect(field).toBeFocused()
    await expect(field).toHaveValue(typed)
  }
  if (typed.length < 200) throw new Error("typed less than 200 characters")
  expect(await field.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([typed.length, typed.length])
  await expect(card).toHaveAttribute("data-probe", "mounted")

  // A caret in the middle stays where the human put it across a refresh.
  await field.evaluate(el => el.setSelectionRange(10, 10))
  await refresh(21)
  expect(await field.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([10, 10])
  await field.evaluate(el => el.setSelectionRange(el.value.length, el.value.length))

  // An IME composition in progress survives a refresh and commits once.
  const cdp = await context.newCDPSession(page)
  await cdp.send("Input.imeSetComposition", { text: "かな", selectionStart: 2, selectionEnd: 2 })
  await refresh(22)
  await expect(field).toBeFocused()
  await cdp.send("Input.insertText", { text: "仮名" })
  typed += "仮名"
  await expect(field).toHaveValue(typed)
  await expect(card).toHaveAttribute("data-probe", "mounted")

  // Nothing was sent by typing or refreshing.
  expect(preview.ledger.calls.filter(call => call.method === "POST" && call.path.endsWith("/commands"))).toHaveLength(0)

  // Leaving and coming back keeps the draft.
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded" })
  await page.goto(`${preview.url}/?surface=board`, { waitUntil: "domcontentloaded" })
  await card.getByRole("button", { name: "Type something…" }).click()
  await expect(field).toHaveValue(typed)
  expect(errors).toEqual([])
  console.log("surface-decision-typing: PASS")
} finally {
  await browser.close()
  await preview.close()
}
