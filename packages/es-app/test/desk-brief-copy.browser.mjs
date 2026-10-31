// Two posts the human makes themselves (Gleaner case shape, synthetic). The brief anchors each post in the request;
// the decision view shows one "To post" block per post whose Copy writes exactly the request's own bytes, never
// "Would post". When a quote cannot be verified, the card says so and the original request opens in full.
// Hand-written brief (no model call). Run from packages/es-app: node test/desk-brief-copy.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"
import { createHash } from "node:crypto"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const now = Date.now()
const DRAFTS = "https://example.com/posts.html"
const POST1 = [":spring: *Spring Boot 3 upgrade* lands Monday.", "", "Pilot PRs: https://github.com/o/r/pull/1 and https://github.com/o/r/pull/2", "Run `make upgrade` locally first.", "", "Do I need to do anything? No. This is a one-time upgrade."].join("\n")
const POST2 = [":package: *Protobuf 4* follows on Wednesday.", "", "Notes: https://example.com/protobuf", "", "Do I need to do anything? No. This is a one-time upgrade."].join("\n")
const CONTEXT = [`Please post these two announcements in #platform-changes. Drafts: ${DRAFTS}`, "", "===== Post 1 =====", "## Post 1", "", POST1, "", "===== Post 2 =====", "## Post 2", "", POST2, ""].join("\n")
const record = { id: "posts", editspace: "fixture", status: "open", kind: "decision", producer_session: "ses_a", origin_session: "ses_a",
  source_ref: { session_id: "ses_a", directory }, decision: null, delivery_state: "not-requested", updated_at: now, snoozed_until: null,
  revision: 1, created_at: now - 300_000, gate_key: "posts:v1", lane: "gleaner",
  title: "Please post these two announcements in #platform-changes", context: CONTEXT,
  options: [{ id: "posted-both", label: "Posted both" }, { id: "posted-sb3", label: "Posted Spring Boot only" }, { id: "hold", label: "Hold" }], recommendation: "posted-both" }
const refs = [{ id: "C1", label: "canonical decision" }, { id: "U1", label: "link in the canonical request", url: DRAFTS }]
const good = {
  question: "Post the two announcements in #platform-changes, then record which you posted.",
  context: "Both drafts are ready to paste.",
  choices: [{ id: "posted-both", outcome: "Records that you posted both" }, { id: "posted-sb3", outcome: "Records that you posted Spring Boot only" }, { id: "hold", outcome: "Nothing is recorded as posted" }],
  subjects: [{ name: "Announcement drafts", refs: ["U1"] }],
  copy: [{ label: "Spring Boot 3", to: "#platform-changes", start: ":spring: *Spring Boot 3 upgrade*", end: "No. This is a one-time upgrade." },
    { label: "Protobuf 4", to: "#platform-changes", start: ":package: *Protobuf 4*", end: "No. This is a one-time upgrade." }],
  gaps: [],
}
// The model also re-typed a post into sends (blank lines collapsed): that quote fails verification.
const retyped = { ...good, sends: POST1.replace(/\n\n/g, "\n"), sendsTo: "#platform-changes" }
let result = good
const message = (id, sessionID, role, text) => ({
  info: { id, sessionID, role, time: { created: now - 60_000, ...(role === "assistant" ? { completed: now - 30_000 } : {}) }, ...(role === "assistant" ? { modelID: "fixture", providerID: "fixture", mode: "build", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, parentID: "msg_user" } : { agent: "build", model: { providerID: "fixture", modelID: "fixture" } }) },
  parts: [{ id: `${id}_part`, sessionID, messageID: id, type: "text", text }],
})
const session = (id, extra = {}) => ({ id, slug: id, projectID: "fixture", directory, title: id, version: "1", time: { created: now - 120_000, updated: now - 30_000 }, ...extra })
const send = (res, body) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)) }
const preview = await startAttentionPreview([{
  name: "copy-brief-fixture",
  configureServer(server) {
    server.middlewares.use("/es/api/frontdesk/conversation", (_req, res) => send(res, { threads: [] }))
    server.middlewares.use("/oc/session", (req, res, next) => {
      const [, id, tail] = new URL(req.url, "http://preview").pathname.split("/")
      if (id?.startsWith("ses_fdbrief_") && !tail) return send(res, session(id, { time: { created: now, updated: now, archived: now } }))
      if (id?.startsWith("ses_fdbrief_") && tail === "children") return send(res, [session("ses_brief_posts", { parentID: id, metadata: { frontDesk: {
        kind: "brief", requestID: "ses_brief_posts", source: "attention:fixture:posts", revision: "1", title: record.title, refs, contract: 4 } } })])
      if (id === "ses_brief_posts" && tail === "message") return send(res, [message("msg_user", id, "user", "packet"), message("msg_reply", id, "assistant", JSON.stringify(result))])
      next()
    })
  },
}])
preview.fixture.editspaces = [{ name: "fixture", root: directory }]
let failed = false
const browser = await chromium.launch({ channel: "chrome", headless: true })
const open = async (viewport, rtl = false) => {
  const context = await browser.newContext({ viewport, permissions: ["clipboard-read", "clipboard-write"] })
  await context.addInitScript(() => { try { localStorage.setItem("es-app-all-projects", "true"); localStorage.setItem("es-app:front-desk:auto-prepare", "off"); localStorage.setItem("es-app:front-desk:chat-hidden", "0") } catch {} })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultNavigationTimeout(300_000)
  page.setDefaultTimeout(90_000)
  page.on("pageerror", error => console.error(`pageerror: ${error.message}`))
  await page.goto(`${preview.origin}/?item=${encodeURIComponent("attention:fixture:posts")}`)
  if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
  return { page, card: page.locator('[data-attention-id="posts"]') }
}
try {
  preview.ledger.records.splice(0, preview.ledger.records.length, record)
  for (const [name, viewport, rtl] of [["desktop", { width: 1440, height: 1000 }, false], ["phone", { width: 390, height: 844 }, false], ["rtl", { width: 390, height: 844 }, true]]) {
    result = good
    const { page, card } = await open(viewport, rtl)
    await expect(card.locator("h3.home-question")).toHaveText(good.question, { timeout: 120_000 })
    const blocks = card.locator("figure.home-sends")
    await expect(blocks).toHaveCount(2)
    await expect(blocks.nth(0).locator("figcaption")).toHaveText("To post · #platform-changes · Spring Boot 3")
    await expect(blocks.nth(1).locator("figcaption")).toHaveText("To post · #platform-changes · Protobuf 4")
    await expect(card).not.toContainText("Would post")
    await expect(card.locator(".home-quote-failed")).toHaveCount(0)
    // Each Copy writes exactly that post's bytes from the request: no heading, separator or label.
    for (const [index, expected] of [[0, POST1], [1, POST2]]) {
      await blocks.nth(index).getByRole("button", { name: /^Copy / }).click()
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected, `${name}: block ${index} clipboard`)
    }
    await expect(blocks.nth(0).locator("blockquote")).not.toContainText("## Post")
    const overflow = await card.evaluate(element => element.scrollWidth - element.clientWidth)
    assert(overflow <= 1, `${name}: card overflows by ${overflow}px`)
    if (shots) await page.screenshot({ path: path.join(shots, `copy-${name}.png`), fullPage: true })
    console.log(`COPY ${name}: two To post blocks, clipboard byte-equal, no Would post`)
    await page.context().close()
  }
  for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["phone", { width: 390, height: 844 }]]) {
    result = retyped
    const { page, card } = await open(viewport)
    await expect(card.locator(".home-quote-failed")).toBeVisible({ timeout: 120_000 })
    await expect(card.locator("figure.home-sends")).toHaveCount(2)
    await expect(card).not.toContainText("Would post")
    await expect(card.locator("details.home-details")).toHaveAttribute("open", "")
    await expect(card.locator("details.home-details .home-original")).toBeVisible()
    await expect(card.locator("details.home-details .home-original")).toContainText("Protobuf 4")
    if (shots) await page.screenshot({ path: path.join(shots, `copy-failed-${name}.png`), fullPage: true })
    console.log(`COPY quote failed ${name}: line shown, request unfolded`)
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
console.log("PASS desk-brief-copy")
