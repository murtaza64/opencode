// A decision whose recommended option is done by hand in a web console. The producer's numbered steps stay
// readable in full above the answer, with or without a brief; a brief adds a walkthrough (page link, each field
// with its exact value, how to check) where a value the request never states shows as missing, not a guess.
// Synthetic fixture: example.com console, hand-written brief (no model call).
// Run from packages/es-app: node test/desk-brief-steps.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"
import { createHash } from "node:crypto"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const now = Date.now()
const OTHER_ROOT = "/fixture/other project"
const OTHER_ANCHOR = `ses_fdbrief_${createHash("sha256").update(OTHER_ROOT).digest("hex").slice(0, 20)}`
const CONSOLE = "https://console.example.com/zones/z1/security/rules"
// The producer's own numbered steps: two rules, each with the exact values the human must type.
const CONTEXT = [
  "The edge console needs two rate-limit rules; I cannot change it myself.",
  `1. Open ${CONSOLE} and choose Create rule.`,
  "2. Rule api-burst: field URI Path, operator starts with, value /api/, limit 100 requests per 10 seconds, action Block.",
  "3. Rule login-slow: field URI Path, operator equals, value /login, limit 20 requests per 1 minute, action Managed Challenge.",
  "4. Save both and confirm they show as Active.",
].join("\n")
// Every value the human must type or open: each must be readable above the answer, brief or no brief.
const CANONICAL = [CONSOLE, "starts with", "/api/", "100 requests per 10 seconds", "equals", "/login", "20 requests per 1 minute", "Managed Challenge"]
const record = { id: "rule", editspace: "fixture", status: "open", kind: "decision", producer_session: "ses_a", origin_session: "ses_a",
  source_ref: { session_id: "ses_a", directory }, decision: null, delivery_state: "not-requested", updated_at: now, snoozed_until: null,
  revision: 1, created_at: now - 300_000, gate_key: "rule:v1", lane: "edge-rules",
  title: "Add the two rate-limit rules in the edge console?", context: CONTEXT,
  options: [{ id: "apply", label: "I'll add both rules now" }, { id: "skip", label: "Leave the console unchanged" }], recommendation: "apply" }
const refs = [{ id: "C1", label: "canonical decision" }, { id: "U1", label: "link in the canonical request", url: CONSOLE }]
const result = {
  question: "Add two rate limits at the edge?",
  context: "The console change has to be made by hand.",
  choices: [{ id: "apply", outcome: "Bursts on the API and login are limited once saved" }, { id: "skip", outcome: "Traffic stays unlimited" }],
  steps: [
    { title: "Open the rules page", where: { label: "Edge console rules", refs: ["U1"] }, settings: [], verify: "", option: "apply" },
    { title: "Create api-burst", option: "apply", verify: "show as Active",
      settings: [{ field: "Operator", value: "starts with", refs: ["C1"] }, { field: "Value", value: "/api/", refs: ["C1"] },
        { field: "Limit", value: "100 requests per 10 seconds", refs: ["C1"] }, { field: "Counting window", value: "10 minutes", refs: ["C1"] }] },
  ],
  gaps: [],
}
let briefFails = false
const message = (id, sessionID, role, text) => ({
  info: { id, sessionID, role, time: { created: now - 60_000, ...(role === "assistant" ? { completed: now - 30_000 } : {}) }, ...(role === "assistant" ? { modelID: "fixture", providerID: "fixture", mode: "build", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, parentID: "msg_user" } : { agent: "build", model: { providerID: "fixture", modelID: "fixture" } }) },
  parts: [{ id: `${id}_part`, sessionID, messageID: id, type: "text", text }],
})
const session = (id, extra = {}) => ({ id, slug: id, projectID: "fixture", directory, title: id, version: "1", time: { created: now - 120_000, updated: now - 30_000 }, ...extra })
const send = (res, body) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)) }
const preview = await startAttentionPreview([{
  name: "steps-brief-fixture",
  configureServer(server) {
    server.middlewares.use("/es/api/frontdesk/conversation", (_req, res) => send(res, { threads: [] }))
    server.middlewares.use("/oc/session", (req, res, next) => {
      const [, id, tail] = new URL(req.url, "http://preview").pathname.split("/")
      if (id?.startsWith("ses_fdbrief_") && !tail) return send(res, session(id, { time: { created: now, updated: now, archived: now } }))
      // The brief was prepared while another project was in view: it lives only under that project's anchor.
      if (id?.startsWith("ses_fdbrief_") && tail === "children" && id !== OTHER_ANCHOR) return send(res, [])
      if (id?.startsWith("ses_fdbrief_") && tail === "children") return send(res, [session("ses_brief_rule", { parentID: id, metadata: { frontDesk: {
        kind: "brief", requestID: "ses_brief_rule", source: "attention:fixture:rule", revision: "1", title: record.title, refs, contract: 4 } } })])
      if (id === "ses_brief_rule" && tail === "message") return send(res, briefFails
        ? [message("msg_user", id, "user", "packet"), { ...message("msg_reply", id, "assistant", ""), info: { ...message("msg_reply", id, "assistant", "").info, error: { name: "ProviderAuthError" } } }]
        : [message("msg_user", id, "user", "packet"), message("msg_reply", id, "assistant", JSON.stringify(result))])
      next()
    })
  },
}])
preview.fixture.editspaces = [{ name: "fixture", root: directory }, { name: "other", root: OTHER_ROOT }]
let failed = false
const browser = await chromium.launch({ channel: "chrome", headless: true })
const open = async (viewport, rtl = false) => {
  const context = await browser.newContext({ viewport })
  await context.addInitScript(() => { try { localStorage.setItem("es-app-all-projects", "true"); localStorage.setItem("es-app:front-desk:auto-prepare", "off"); localStorage.setItem("es-app:front-desk:chat-hidden", "0") } catch {} })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  // A cold dev server on a busy host can take minutes for the first load.
  page.setDefaultNavigationTimeout(300_000)
  page.setDefaultTimeout(90_000)
  page.on("pageerror", error => console.error(`pageerror: ${error.message}`))
  await page.goto(`${preview.origin}/?item=${encodeURIComponent("attention:fixture:rule")}`)
  if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
  return { page, card: page.locator('[data-attention-id="rule"]') }
}
// Each canonical value is visible and legible (contrast 4.5:1), outside any closed fold, and before the first
// answer controls (above them when stacked).
const aboveAnswer = (card, stacked) => card.evaluate((element, [values, stacked]) => {
  // Markdown wraps text in display: contents blocks, which have no box of their own.
  const box = node => getComputedStyle(node).display === "contents" ? box(node.parentElement) : node
  // WCAG contrast of the node's text colour against the nearest opaque background behind it.
  const rgb = value => value.match(/[\d.]+/g).map(Number)
  const luminance = ([r, g, b]) => [r, g, b].map(c => c / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0)
  const contrast = node => {
    let back = node
    while (back && (rgb(getComputedStyle(back).backgroundColor)[3] ?? 1) === 0) back = back.parentElement
    const [a, b] = [luminance(rgb(getComputedStyle(node).color)), luminance(rgb(back ? getComputedStyle(back).backgroundColor : "rgb(255,255,255)"))]
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }
  const option = element.querySelector(".home-decision-act")
  const top = option.getBoundingClientRect().top
  return values.filter(value => ![...element.querySelectorAll(".home-decision-explain *")].some(node =>
    [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.includes(value) || child.nodeName === "A" && child.getAttribute("href") === value)
    && box(node).checkVisibility() && !node.closest("details:not([open])") && contrast(node) >= 4.5
    && (node.compareDocumentPosition(option) & Node.DOCUMENT_POSITION_FOLLOWING)
    && (!stacked || box(node).getBoundingClientRect().bottom <= top)))
}, [CANONICAL, stacked])
try {
  preview.ledger.records.splice(0, preview.ledger.records.length, record)
  for (const [name, viewport, rtl] of [["desktop", { width: 1440, height: 1000 }, false], ["phone", { width: 390, height: 844 }, false], ["rtl", { width: 390, height: 844 }, true]]) {
    briefFails = false
    const { page, card } = await open(viewport, rtl)
    await expect(card.locator("h3.home-question")).toHaveText("Add two rate limits at the edge?", { timeout: 120_000 })
    assert.deepEqual(await aboveAnswer(card, viewport.width < 600), [], `${name}: canonical values not above the answer`)
    await expect(card.locator("details.home-original")).toHaveCount(0)
    const steps = card.locator('ol[aria-label="Steps to do"] > li')
    await expect(steps).toHaveCount(2)
    await expect(steps.nth(0)).toContainText("for “I'll add both rules now”")
    // The page link is the request's own URL, opened outside the app.
    const link = steps.nth(0).locator("a")
    await expect(link).toHaveAttribute("href", CONSOLE)
    await expect(link).toHaveAttribute("target", "_blank")
    // Fields in order; values copyable exactly as the request states them.
    const settings = steps.nth(1).locator('ul[aria-label="Settings"] > li')
    await expect(settings.locator(".desk-command-label")).toHaveText(["Operator", "Value", "Limit", "Counting window"])
    await expect(settings.locator("code")).toHaveText(["starts with", "/api/", "100 requests per 10 seconds"])
    // A value the request never gives is shown as missing, never as the brief's guess.
    await expect(settings.nth(3)).toContainText("Not given in the request; ask before applying.")
    await expect(card).not.toContainText("10 minutes")
    await expect(steps.nth(1)).toContainText("Check: show as Active")
    const overflow = await card.evaluate(element => element.scrollWidth - element.clientWidth)
    assert(overflow <= 1, `${name}: card overflows by ${overflow}px`)
    if (shots) await page.screenshot({ path: path.join(shots, `steps-${name}.png`), fullPage: true })
    console.log(`STEPS ${name}: canonical values above the answer, 2 brief steps, console link, 3 exact values, 1 missing`)
    await page.context().close()
  }
  // With the brief failed, the request as written still carries every value above the answer.
  for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["phone", { width: 390, height: 844 }]]) {
    briefFails = true
    const { page, card } = await open(viewport)
    await expect(card.locator(".home-request-text")).toContainText("100 requests per 10 seconds", { timeout: 120_000 })
    await expect(card.locator('ol[aria-label="Steps to do"]')).toHaveCount(0)
    assert.deepEqual(await aboveAnswer(card, viewport.width < 600), [], `${name} (brief failed): canonical values not above the answer`)
    if (shots) await page.screenshot({ path: path.join(shots, `steps-failed-${name}.png`), fullPage: true })
    console.log(`STEPS brief failed ${name}: canonical values above the answer`)
    await page.context().close()
  }
} catch (error) {
  failed = true
  console.error(error)
} finally {
  await browser.close()
  await preview.close()
}
if (failed) process.exit(1)
console.log("PASS desk-brief-steps")
