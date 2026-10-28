// Run from packages/es-app: bun test/brief-items.browser.mjs
// Synthetic ledger and brief session; no model call or persistent answer.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = "/Users/murtaza/editspaces/opencode/lanes/es-app/work/evidence/s3"
const now = Date.now()
const data = [
  ["D1", "Which modifier do app chords use on Linux?", "Alt", "Ctrl"],
  ["D2", "Which key returns to the last session?", "Mod+`", "Ctrl+6"],
  ["D3", "Which key opens the command palette?", "Mod+K", "Mod+P"],
  ["D4", "Does Linux also accept Ctrl+M to cycle modes?", "also accept Ctrl+M", "Super+M only"],
  ["D5", "Does jk leave insert mode?", "yes, within 200 ms", ""],
  ["D6", "Do Ctrl+H/E/N/P/D/U edit text while typing?", "restore text editing except Ctrl+E", "keep app keys"],
  ["D7", "What does Tab do in insert mode?", "keep session switch plus F6", "normal mode only"],
]
const record = {
  id: "keys", editspace: "fixture", revision: 2, content_revision: 2, status: "open", kind: "decision", title: "Approve the seven keyboard decisions?",
  context: ["Seven keyboard decisions; recommendations first.", ...data.map(([id, question, recommended, alternative]) => `${id}. ${question} Recommended: ${recommended}.${alternative ? ` Alternative: ${alternative}.` : ""}`)].join("\n"),
  options: [{ id: "accept", label: "Accept all recommendations" }, { id: "change", label: "Change some" }], recommendation: "accept",
  producer_session: "ses_a", origin_session: "ses_a", gate_key: "keys", source_ref: { session_id: "ses_a", directory },
  decision: null, delivery_state: "not-requested", created_at: now - 1000, updated_at: now,
}
const visual = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 480" font-family="system-ui" font-size="13"><text x="4" y="30">Top of visual</text><text x="4" y="470">Bottom of visual</text></svg>`
const result = {
  question: record.title, context: "Seven keyboard decisions; recommendations first.",
  choices: record.options.map(option => ({ id: option.id, outcome: option.label })),
  items: data.map(([id, question, recommended, alternative]) => ({ id, question, recommended: id === "D3" ? "Invented recommendation" : recommended, alternatives: alternative ? [alternative] : [], refs: ["C1"] })),
  visual: { title: "Keyboard layout", alt: "Top and bottom of keyboard visual", svg: visual },
}
const send = (res, body) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)) }
const session = (id, extra = {}) => ({ id, slug: id, projectID: "fixture", directory, title: id, version: "1", time: { created: now - 120_000, updated: now - 30_000 }, ...extra })
const message = (id, role, text) => ({
  info: { id, sessionID: "ses_brief_keys", role, time: { created: now - 60_000, ...(role === "assistant" ? { completed: now - 30_000 } : {}) },
    ...(role === "assistant" ? { modelID: "fixture", providerID: "fixture", mode: "build", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, parentID: "msg_user" } : { agent: "build", model: { providerID: "fixture", modelID: "fixture" } }) },
  parts: [{ id: `${id}_part`, sessionID: "ses_brief_keys", messageID: id, type: "text", text }],
})
const preview = await startAttentionPreview([{
  name: "brief-items-fixture",
  configureServer(server) {
    server.middlewares.use("/oc/session", (req, res, next) => {
      const [, id, tail] = new URL(req.url, "http://preview").pathname.split("/")
      if (id?.startsWith("ses_fdbrief_") && !tail) return send(res, session(id, { time: { created: now, updated: now, archived: now } }))
      if (id?.startsWith("ses_fdbrief_") && tail === "children") return send(res, [session("ses_brief_keys", { parentID: id, metadata: { frontDesk: {
        kind: "brief", requestID: "ses_brief_keys", source: "attention:fixture:keys", revision: "2", title: record.title,
        refs: [{ id: "C1", label: "canonical request" }], contract: 4,
      } } })])
      if (id === "ses_brief_keys" && tail === "message") return send(res, [message("msg_user", "user", "packet"), message("msg_reply", "assistant", JSON.stringify(result))])
      next()
    })
  },
}])
preview.fixture.editspaces = [{ name: "fixture", root: directory }]
preview.ledger.records.push(record)
const browser = await chromium.launch({ channel: "chrome", headless: true })
let failed = false
const open = async (width, height, rtl = false) => {
  const context = await browser.newContext({ viewport: { width, height } })
  await context.addInitScript(() => { try { localStorage.setItem("es-app-all-projects", "true"); localStorage.setItem("es-app:front-desk:auto-prepare", "off"); localStorage.setItem("es-app:companion:work", "0") } catch {} })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultNavigationTimeout(300_000)
  page.setDefaultTimeout(90_000)
  await page.goto(`${preview.origin}/?item=attention%3Afixture%3Akeys`)
  if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
  const card = page.locator('[data-attention-id="keys"]')
  await expect(card.locator(".desk-brief-item")).toHaveCount(7, { timeout: 120_000 })
  return { page, card }
}
try {
  const normal = await open(1440, 800)
  const rows = normal.card.locator(".desk-brief-item")
  assert.deepEqual(await rows.locator(".desk-brief-item-id bdi").allTextContents(), data.map(row => row[0]))
  assert.deepEqual(await rows.locator(".desk-brief-item-number").allTextContents(), ["1.", "2.", "3.", "4.", "5.", "6.", "7."])
  await expect(rows.nth(2)).toContainText("Not given in the request")
  await expect(rows.nth(4)).toContainText("Not given in the request")
  // Unanswered: no Approved label, value or column.
  await expect(normal.card.locator(".desk-brief-item-head")).not.toContainText("Approved")
  await expect(rows.locator(".desk-brief-item-label", { hasText: "Approved" })).toHaveCount(0)
  await expect(rows.locator(".desk-brief-item-label", { hasText: "Question" })).toHaveCount(0)
  const frame = normal.card.locator(".desk-visual iframe")
  const box = await frame.boundingBox()
  assert(box && box.width <= 360.5 && Math.abs(box.height / box.width - 480 / 360) < .02, JSON.stringify(box))
  const window = normal.card.locator(".desk-visual-window")
  const capped = await window.evaluate(element => ({ height: element.clientHeight, scroll: element.scrollHeight, viewport: innerHeight }))
  assert(capped.height <= capped.viewport * .45 + 1 && capped.scroll > capped.height, JSON.stringify(capped))
  await normal.page.screenshot({ path: path.join(shots, "items-normal.png"), fullPage: true })
  await normal.card.getByRole("button", { name: "Expand visual to full" }).click()
  const expanded = await window.evaluate(element => ({ height: element.clientHeight, scroll: element.scrollHeight }))
  assert(expanded.height >= box.height - 1 && expanded.height === expanded.scroll, JSON.stringify(expanded))
  await expect(normal.card.getByRole("button", { name: "Collapse visual" })).toHaveAttribute("aria-expanded", "true")
  await normal.page.screenshot({ path: path.join(shots, "items-expanded.png"), fullPage: true })
  console.log("ITEMS normal 7 ordered rows; missing values; unapproved; visual ≤1x, 45vh cap and expand: PASS")

  const narrow = await open(360, 800)
  assert(await narrow.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "360px horizontal overflow")
  assert.deepEqual(await narrow.card.locator(".desk-brief-item-id bdi").allTextContents(), data.map(row => row[0]))
  await expect(narrow.card.locator(".desk-brief-item-label").first()).toBeVisible()
  await narrow.card.screenshot({ path: path.join(shots, "items-360.png") })
  console.log("ITEMS 360px stacked, no horizontal overflow: PASS")

  const rtl = await open(360, 800, true)
  assert(await rtl.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "RTL horizontal overflow")
  assert.equal(await rtl.card.locator(".desk-brief-item-id bdi").first().getAttribute("dir"), "ltr")
  assert.deepEqual(await rtl.card.locator(".desk-brief-item-id bdi").allTextContents(), data.map(row => row[0]))
  await rtl.card.screenshot({ path: path.join(shots, "items-360-rtl.png") })
  console.log("ITEMS RTL 360px ordered IDs, no horizontal overflow: PASS")

  record.status = "answered"
  record.answer = { id: "answer", choice_id: "accept", text: "Confirmed", answered_at: now, revision: 2, brief: { job: "ses_brief_keys", revision: "2" } }
  const generic = await open(1440, 800)
  await expect(generic.card.locator(".desk-brief-item-cell:last-child")).toHaveCount(7)
  assert.deepEqual(await generic.card.locator(".desk-brief-item-cell:last-child").allTextContents(), Array(7).fill("ApprovedNot individually recorded"))
  await expect(generic.card.locator(".desk-brief-ledger")).toHaveCount(1)
  await expect(generic.card.locator(".desk-brief-ledger")).toContainText("Accept all recommendations · Confirmed")
  await generic.card.screenshot({ path: path.join(shots, "items-generic-answer.png") })
  console.log("ITEMS generic answer: all unrecorded; verbatim ledger answer once: PASS")

  record.answer = { ...record.answer, input_value: "D1: Alt; D3: Mod+P" }
  const mapped = await open(1440, 800)
  await expect(mapped.card.locator(".desk-brief-item-cell:last-child").first()).toContainText("D1: Alt")
  await expect(mapped.card.locator(".desk-brief-item-cell:last-child").nth(2)).toContainText("D3: Mod+P")
  await expect(mapped.card.locator(".desk-brief-item-cell:last-child").nth(1)).toContainText("Not individually recorded")
  await expect(mapped.card.locator(".desk-brief-ledger")).toHaveCount(1)
  await mapped.card.screenshot({ path: path.join(shots, "items-mapped-answer.png") })
  console.log("ITEMS mapped answer: only named IDs marked; other rows unrecorded: PASS")
  console.log("BRIEF ITEMS: PASS")
} catch (error) {
  failed = true
  console.error(error)
} finally {
  await Promise.race([Promise.all([browser.close(), preview.close()]), new Promise(resolve => setTimeout(resolve, 3000))])
  process.exit(failed ? 1 : 0)
}
