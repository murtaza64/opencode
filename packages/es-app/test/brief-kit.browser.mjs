// Brief gallery: every brief state on one synthetic queue, checked against attention-lead's evidence/copy checklist
// (1-11) at desktop, 390 px and RTL. Cases: single choice, 7 items, grilling series, steps, visual-heavy, no visual,
// brief error, brief absent. Hand-written contract-4 briefs; no model call, no real content.
// Run from packages/es-app: node test/brief-kit.browser.mjs [--shots DIR] [--report-only] [--serve]
//   --report-only  prints the checklist table without failing (for "before" screenshots on an older build)
//   --serve        leaves the preview running after the checks and prints its URL
//   --serve-only   starts the preview without any checks or browser (a review server, e.g. for a frozen baseline)
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const arg = name => process.argv.includes(name)
const shots = arg("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const reportOnly = arg("--report-only")
const now = Date.now()
const base = { editspace: "fixture", status: "open", kind: "decision", producer_session: "ses_a", origin_session: "ses_a", source_ref: { session_id: "ses_a", directory },
  decision: null, delivery_state: "not-requested", created_at: now - 300_000, updated_at: now, snoozed_until: null, revision: 1, lane: "gallery" }
const two = [{ id: "go", label: "Go ahead" }, { id: "wait", label: "Wait a week" }]
const svg = (height, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 ${height}" font-family="system-ui,sans-serif" font-size="14" style="fill:var(--fg)">${body}</svg>`
const tall = svg(880, Array.from({ length: 10 }, (_, i) => `<rect x="20" y="${20 + i * 85}" width="320" height="60" rx="6" style="fill:var(--surface);stroke:var(--line)"/><text x="36" y="${56 + i * 85}">Stage ${i + 1}: rollout to ${(i + 1) * 10}%</text>`).join(""))
const ITEMS = [["D1", "Which modifier?", "Alt", "Ctrl"], ["D2", "Last session key?", "Mod+`", "Ctrl+6"], ["D3", "Palette key?", "Mod+K", "Mod+P"], ["D4", "Accept Ctrl+M?", "yes", "no"],
  ["D5", "jk leaves insert?", "yes, 200 ms", ""], ["D6", "Ctrl keys edit text?", "restore except Ctrl+E", "keep app keys"], ["D7", "Tab in insert?", "keep plus F6", "normal mode only"]]
const CONSOLE = "https://console.example.com/rules"

// Each case: its record(s), and its brief: a result, "error", or none (absent).
const CASES = {
  single: { record: { ...base, id: "single", gate_key: "single", title: "Ship the cache change?", context: "Canary healthy for a day. Rollback is one flag.", options: two, recommendation: "go" },
    brief: { question: "Turn the faster cache on for everyone?", context: "The canary ran a day without errors.", choices: [{ id: "go", outcome: "Everyone gets faster pages" }, { id: "wait", outcome: "Only the canary has it for a week" }],
      facts: [{ text: "Canary error rate unchanged for 24 h", refs: ["C1"] }], gaps: ["Cost at full traffic is not measured."], shape: { kind: "compare", columns: ["go", "wait"], rows: [{ label: "Who gets it", cells: ["Everyone", "Canary only"] }] } } },
  items: { record: { ...base, id: "items", gate_key: "items", title: "Approve the seven keyboard decisions?", options: [{ id: "accept", label: "Accept all recommendations" }, { id: "change", label: "Change some" }], recommendation: "accept",
      context: ["Seven decisions.", ...ITEMS.map(([id, q, r, a]) => `${id}. ${q} Recommended: ${r}.${a ? ` Alternative: ${a}.` : ""}`)].join("\n") },
    brief: { question: "Approve the seven keyboard choices?", choices: [{ id: "accept", outcome: "All seven recommendations apply" }, { id: "change", outcome: "You name what changes" }],
      items: ITEMS.map(([id, question, recommended, alternative]) => ({ id, question, recommended, alternatives: alternative ? [alternative] : [], refs: ["C1"] })) } },
  series: { records: [1, 2, 3].map(index => ({ ...base, id: `series${index}`, gate_key: `grill:${index}`, title: `Question ${index}: which default?`, context: `Grilling question ${index}.`,
      options: [{ id: "rec", label: "Suggested default" }, { id: "alt", label: "Alternative" }], recommendation: "rec", series: { id: "grill", index, title: "Grilling: workspace defaults" } })), brief: "none" },
  steps: { record: { ...base, id: "steps", gate_key: "steps", title: "Add the rate-limit rule?", options: two, recommendation: "go",
      context: [`1. Open ${CONSOLE} and choose Create rule.`, "2. Set operator starts with, value /api/, limit 100 requests per 10 seconds.", "3. Confirm it shows as Active."].join("\n") },
    brief: { question: "Add a rate limit for the API?", choices: [{ id: "go", outcome: "API bursts are limited" }, { id: "wait", outcome: "Unlimited for a week" }],
      steps: [{ title: "Create the rule", where: { label: "Edge console rules", refs: ["U1"] }, option: "go", verify: "shows as Active",
        settings: [{ field: "Operator", value: "starts with", refs: ["C1"] }, { field: "Value", value: "/api/", refs: ["C1"] }, { field: "Window", value: "10 minutes", refs: ["C1"] }] }] } },
  visual: { record: { ...base, id: "visual", gate_key: "visual", title: "Roll out in ten stages?", context: "Ten stages of 10% each, a day apart.", options: two, recommendation: "go" },
    brief: { question: "Roll out in ten daily stages?", choices: [{ id: "go", outcome: "Ten days to full rollout" }, { id: "wait", outcome: "Nothing changes for a week" }],
      visual: { title: "Stages", alt: "Ten stacked stages from 10% to 100% rollout.", svg: tall } } },
  plain: { record: { ...base, id: "plain", gate_key: "plain", title: "Rename the ledger table?", context: "The name collides with a new view.", options: two, recommendation: "wait" },
    brief: { question: "rename the ledger  table?", context: "Its name collides with a new view.", choices: [{ id: "go", outcome: "Renamed today" }, { id: "wait", outcome: "Renamed after the migration" }] } },
  error: { record: { ...base, id: "error", gate_key: "error", title: "Archive the old dashboards?", context: "Twelve dashboards unused since June.", options: two, recommendation: "go" }, brief: "error" },
  absent: { record: { ...base, id: "absent", gate_key: "absent", title: "Close the stale tickets?", context: "Nine tickets untouched for 90 days.", options: two, recommendation: "go" }, brief: "none" },
}
const refsFor = record => [{ id: "C1", label: "canonical decision" }, ...(record.context.match(/https?:\/\/\S+/g) ?? []).map((url, index) => ({ id: `U${index + 1}`, label: "link in the canonical request", url: url.replace(/[.,]$/, "") }))]
const message = (id, sessionID, role, text, error) => ({
  info: { id, sessionID, role, time: { created: now - 60_000, ...(role === "assistant" ? { completed: now - 30_000 } : {}) }, ...(error ? { error: { name: error } } : {}), ...(role === "assistant" ? { modelID: "fixture", providerID: "fixture", mode: "build", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, parentID: "msg_user" } : { agent: "build", model: { providerID: "fixture", modelID: "fixture" } }) },
  parts: [{ id: `${id}_part`, sessionID, messageID: id, type: "text", text }],
})
const session = (id, extra = {}) => ({ id, slug: id, projectID: "fixture", directory, title: id, version: "1", time: { created: now - 120_000, updated: now - 30_000 }, ...extra })
const send = (res, body) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)) }
const jobs = Object.entries(CASES).filter(([, value]) => value.brief !== "none").map(([name, value]) => ({ id: `ses_fdjob_${name.padEnd(24, "0").slice(0, 24)}`, name, value }))
const preview = await startAttentionPreview([{
  name: "brief-gallery",
  configureServer(server) {
    server.middlewares.use("/es/api/frontdesk/conversation", (_req, res) => send(res, { threads: [] }))
    server.middlewares.use("/es/api/frontdesk/brief-feedback", (_req, res) => send(res, { entry: null }))
    server.middlewares.use("/oc/session", (req, res, next) => {
      const [, id, tail] = new URL(req.url, "http://preview").pathname.split("/")
      if (id?.startsWith("ses_fdbrief_") && !tail) return send(res, session(id, { time: { created: now, updated: now, archived: now } }))
      if (id?.startsWith("ses_fdbrief_") && tail === "children") return send(res, jobs.map(job => session(job.id, { parentID: id, metadata: { frontDesk: {
        kind: "brief", requestID: job.id, source: `attention:fixture:${job.value.record.id}`, revision: "1", title: job.value.record.title, refs: refsFor(job.value.record), contract: 4 } } })))
      const job = jobs.find(item => item.id === id)
      if (job && tail === "message") return send(res, job.value.brief === "error"
        ? [message("msg_user", id, "user", "packet"), message("msg_reply", id, "assistant", "", "ProviderAuthError")]
        : [message("msg_user", id, "user", "packet"), message("msg_reply", id, "assistant", JSON.stringify(job.value.brief))])
      next()
    })
  },
}])
preview.fixture.editspaces = [{ name: "fixture", root: directory }]
preview.ledger.records.splice(0, preview.ledger.records.length, ...Object.values(CASES).flatMap(value => value.records ?? [value.record]))
if (arg("--serve-only")) {
  console.log(`SERVING ${preview.origin}/?item=${encodeURIComponent("attention:fixture:single")} (pid ${process.pid}); stop with kill ${process.pid}`)
  await new Promise(() => {})
}
const browser = await chromium.launch({ channel: "chrome", headless: true })
const VIEWS = [["desktop", { width: 1440, height: 1000 }, false], ["390", { width: 390, height: 844 }, false], ["rtl", { width: 390, height: 844 }, true]]
const keyOf = name => name === "series" ? "series:fixture:ses_a:grill" : `attention:fixture:${CASES[name].record.id}`
// A series renders as one series card (data-series-id) holding each question.
const cardOf = (page, name) => page.locator(name === "series" ? '[data-series-id="grill"]' : `[data-attention-id="${CASES[name].record.id}"]`)

// The checklist items a browser can decide; each returns true/false, or a value to report.
const check = async (page, card, name) => card.evaluate((element, [name, missing]) => {
  const visible = node => !!node && node.checkVisibility() && !node.closest("details:not([open])")
  const text = element.innerText
  const question = element.querySelector("h3, h4")
  const firstHeading = [...element.querySelectorAll("h1,h2,h3,h4")].find(visible)
  // A series shows each question's own request text inline.
  const request = name === "series" ? /Grilling question 1\./.test(text) : element.querySelector(".home-request-text, details.home-original")
  const iframe = element.querySelector(".desk-visual iframe")
  const window = element.querySelector(".desk-visual-window")
  const sizes = new Set([...element.querySelectorAll("*")].filter(node => visible(node) && [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim()))
    .map(node => getComputedStyle(node).fontSize))
  const rows = [...element.querySelectorAll(".desk-brief-item-id bdi")].map(node => node.textContent)
  return {
    "1 question first": !!question && firstHeading === question,
    "2 request one tap": !!request,
    "3 rec labelled, no answer shown": !/Recorded answer|You chose/.test(text) && (!element.querySelector(".desk-compare-recommended, .desk-brief-item-head") || /Agent recommends/.test(text)),
    "4 items lossless": name !== "items" || JSON.stringify(rows) === JSON.stringify(["D1", "D2", "D3", "D4", "D5", "D6", "D7"]),
    "4 missing shown": name !== "items" && name !== "steps" || text.includes(missing),
    "5 gaps kept": name !== "single" || element.innerHTML.includes("Cost at full traffic is not measured."),
    "6 steps copyable": name !== "steps" || element.querySelectorAll(".desk-steps .desk-command-copy").length === 2 && /Check: shows as Active/.test(text),
    "7 visual earns place": name === "visual" ? !!iframe && !!iframe.title && !!window && window.getBoundingClientRect().height <= innerHeight * 0.45 + 2 && !!element.querySelector(".desk-visual-expand") : !iframe,
    "8 no title repeat": name !== "plain" || !element.querySelector(".home-request-line"),
    "8 no duplicate request": !(element.querySelector(".home-request-text") && visible(element.querySelector(".home-request-text")) && element.querySelector("details.home-original")) && !/This brief explains|several/.test(text),
    "8 no empty Approved or Question labels": !/Approved/.test(text) && ![...element.querySelectorAll(".desk-brief-item-label")].some(node => node.textContent === "Question"),
    "8 missing styled alike": name !== "items" || !!element.querySelector(".desk-brief-item:nth-child(5) .brief-missing"),
    "8 one failure line": name !== "error" || /The model provider refused sign-in\./.test(text) && !visible([...element.querySelectorAll("p")].find(node => /Briefs unavailable/.test(node.textContent))),
    "9 labels one line, value columns wide": name !== "items" || [...element.querySelectorAll(".desk-brief-item")].every(row => {
      const width = row.getBoundingClientRect().width
      const labels = [...row.querySelectorAll(".desk-brief-item-label")].filter(label => getComputedStyle(label).display !== "none")
      const oneLine = labels.every(label => { const style = getComputedStyle(label); return label.getBoundingClientRect().height <= (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4) * 1.5 + 1 })
      const values = [...row.querySelectorAll(".desk-brief-item-cell")].slice(1, 3)
      return oneLine && values.every(cell => cell.getBoundingClientRect().width >= width * (labels.length ? 0.35 : 0.2))
    }),
    "9 type sizes": sizes.size,
    "9 brief type sizes": new Set([...element.querySelectorAll(".desk-brief *")].filter(node => visible(node) && [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim()))
      .map(node => getComputedStyle(node).fontSize)).size,
    "10 state honest": name === "error" ? /ProviderAuthError/.test(text) && /The model provider refused sign-in/.test(text)
      : name === "absent" ? !!element.querySelector(".home-request-text") && element.querySelectorAll('input[type="radio"]').length >= 2
      : name === "series" ? element.querySelectorAll('input[type="radio"]').length >= 2 : true,
    "11 no overflow": element.scrollWidth <= element.clientWidth + 1,
  }
}, [name, "Not given in the request"])

const table = {}
let failed = false
try {
  for (const [view, viewport, rtl] of VIEWS) {
    const context = await browser.newContext({ viewport })
    await context.addInitScript(() => { try { localStorage.setItem("es-app-all-projects", "true"); localStorage.setItem("es-app:front-desk:auto-prepare", "off") } catch {} })
    await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
    for (const name of Object.keys(CASES)) {
      // A fresh page per case, so no case inherits another's selection or scroll.
      const page = await context.newPage()
      page.setDefaultNavigationTimeout(300_000)
      page.setDefaultTimeout(90_000)
      page.on("pageerror", error => console.error(`pageerror: ${error.message}`))
      await page.goto(`${preview.origin}/?item=${encodeURIComponent(keyOf(name))}`)
      if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
      const card = cardOf(page, name)
      await expect(card.locator("h3, h4").first()).toBeVisible({ timeout: 120_000 })
      // Ready briefs settle before checking; failed and absent ones are checked as they stand.
      if (CASES[name].brief !== "none" && CASES[name].brief !== "error") await expect(card.locator(".desk-brief-body, .home-question").first()).toBeVisible()
      if (name === "error") await expect(card.locator('.desk-brief[data-part="lead"]')).toContainText("ProviderAuthError")
      const result = await check(page, card, name)
      table[`${name} ${view}`] = result
      if (shots) await card.screenshot({ path: path.join(shots, `${name}-${view}.png`) }).catch(() => page.screenshot({ path: path.join(shots, `${name}-${view}.png`), fullPage: true }))
      await page.close()
    }
    await context.close()
  }
} catch (error) {
  failed = true
  console.error(error)
}
const columns = Object.keys(Object.values(table)[0] ?? {})
console.log(["case", ...columns].join(" | "))
for (const [row, result] of Object.entries(table)) console.log([row, ...columns.map(column => typeof result[column] === "boolean" ? (result[column] ? "yes" : "NO") : result[column])].join(" | "))
const material = columns.filter(column => !column.startsWith("9 "))
const misses = Object.entries(table).flatMap(([row, result]) => material.filter(column => result[column] === false).map(column => `${row}: ${column}`))
if (!reportOnly && misses.length) { failed = true; console.error(`checklist misses:\n${misses.join("\n")}`) }
if (arg("--serve") && !failed) {
  await browser.close()
  console.log(`SERVING ${preview.origin}/?item=${encodeURIComponent(keyOf("single"))} (pid ${process.pid}); stop with kill ${process.pid}`)
  await new Promise(() => {})
}
await browser.close()
await preview.close()
if (failed) process.exit(1)
console.log(reportOnly ? "REPORT brief-kit" : "PASS brief-kit")
