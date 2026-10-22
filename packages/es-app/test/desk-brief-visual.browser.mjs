// Visual-first decision brief on a long technical approval: the brief leads with the decision, a
// scope picture and per-option outcomes on the choices themselves; the request text folds away.
// An incomplete brief is never presented as a summary. Disposable fixture and hand-written brief
// output (no model call). Run from packages/es-app: node test/desk-brief-visual.browser.mjs [--shots DIR] [--old]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
// --old serves a brief in the previous prose format, for a before screenshot on an older build.
const old = process.argv.includes("--old")
const now = Date.now()

// Representative of a real long approval request (paraphrased; no real system names).
const record = {
  id: "probe", editspace: "fixture", revision: 4, status: "open", kind: "decision", title: "Worker CPU: authorize the read-only storage comparison? Harness ready.",
  context: "Worker CPU per message remains about 9x baseline in matched windows; the cause is unproven. The H1 harness and 12 hermetic tests are ready: pinned stage objects, 50-thread production data-access and direct-storage phases, a fresh process and temporary cache each repetition, real CPU seconds, a read-only GetObject/HeadObject allowlist, and no user payloads, configuration or secrets in output. All code-arm tests ran on the new runtime image locally; the actual old-versus-new runtime comparison has NOT run. The earlier staging plan is abandoned. Running it would push never-merged probe branches, perform one read-only manifest preflight, then six existing build-runner jobs A B C C B A (about 60-90 minutes) using the authenticated build CLI and existing managed credentials. No UI clicks or pasted tokens are needed. The build node's read access to the stage bucket is unknown: the preflight stops on AccessDenied, and no role changes or fallback job are authorized. No deployment, scoring, production change, revert or fix merge. A positive result tests the storage hypothesis, not the whole-worker cure. The pending fix stays held.",
  options: [{ id: "h1-probe", label: "Authorize read-only probe branches, preflight and six build runs" }, { id: "revert-gated", label: "Prepare the revert for normal approval, CI and coordinated rollout" }, { id: "hold-investigate", label: "Keep remote jobs and production unchanged; local investigation only" }],
  recommendation: "h1-probe", producer_session: "ses_a", origin_session: "ses_a", gate_key: "cpu:h1:v4", lane: "batch-orchestrator",
  source_ref: { session_id: "ses_a", directory }, decision: null, delivery_state: "not-requested", created_at: now - 600_000, updated_at: now - 600_000, snoozed_until: null,
}
const thin = { ...record, id: "thin", title: "Rename the ledger table?", context: "The table name collides with a new view. Rename it now or after the migration lands.",
  options: [{ id: "now", label: "Rename now" }, { id: "later", label: "After the migration" }], recommendation: "later", gate_key: "thin:v1", created_at: now - 900_000 }
const refs = [{ id: "C1", label: "canonical decision" }, { id: "E1", label: "assistant message in source session", messageID: "msg_e1" }]
const results = {
  probe: old
    ? { ask: "Authorize the read-only storage comparison now?", whyNow: "The CPU regression investigation is paused until you choose how to proceed with the prepared harness.",
      ifRecommended: "Six read-only build runs compare storage reads across runtimes over about 60-90 minutes without deploying anything.", ifWait: "CPU stays about 9x baseline and nothing runs.",
      summary: "The harness is ready and tested locally, but the actual runtime comparison has not run and the build node's bucket access is unknown.",
      facts: [1, 2, 3, 4, 5, 6, 7].map(n => ({ text: `Supporting detail ${n} about the harness, its limits and what it does not prove.`, refs: ["C1"] })),
      timeline: [], flow: [], gaps: ["Whether the build node can read the stage bucket.", "Whether storage explains all of the CPU regression."] }
    : {
      ask: "",
      whyYou: "It pushes branches and runs build jobs with managed credentials.",
      whyNow: "Worker CPU is ~9x baseline after the runtime upgrade; the fix is held.",
      choices: [
        { id: "h1-probe", outcome: "Six runs test whether storage reads are the cause", chips: ["read-only", "~60-90 min"], risk: "Tests one theory, not the whole fix" },
        { id: "revert-gated", outcome: "Revert goes through normal review and rollout", chips: [], risk: "Cause stays unknown" },
        { id: "hold-investigate", outcome: "Nothing remote runs; local digging only", chips: ["no remote jobs"], risk: "Regression lasts longer" },
      ],
      ifWait: "",
      shape: { kind: "scope", included: ["Read-only object reads", "Six existing build jobs"], excluded: ["Deploys or prod writes", "Role changes"] },
      unknown: "Whether the build node can read the stage bucket.",
      sources: [{ label: "Harness readiness report", refs: ["E1"] }, { label: "The request", refs: ["C1"] }, { label: "Made up", refs: ["E9"] }],
      facts: [{ text: "Code-arm tests passed locally; the runtime comparison has not run.", refs: ["C1"] }, { text: "Preflight stops on AccessDenied with no fallback.", refs: ["E1"] }],
      timeline: [], gaps: ["Whether storage explains all of the CPU regression."],
    },
  // Asked for a picture but got none: this must not stand in for the request.
  thin: { ask: "Rename the ledger table now or later?", whyYou: "", whyNow: "", choices: [], ifWait: "", unknown: "", sources: [], facts: [], timeline: [], gaps: [] },
}
const message = (id, sessionID, role, text) => ({
  info: { id, sessionID, role, time: { created: now - 60_000, ...(role === "assistant" ? { completed: now - 30_000 } : {}) }, ...(role === "assistant" ? { modelID: "fixture", providerID: "fixture", mode: "build", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, parentID: "msg_user" } : { agent: "build", model: { providerID: "fixture", modelID: "fixture" } }) },
  parts: [{ id: `${id}_part`, sessionID, messageID: id, type: "text", text }],
})
const session = (id, extra = {}) => ({ id, slug: id, projectID: "fixture", directory, title: id, version: "1", time: { created: now - 120_000, updated: now - 30_000 }, ...extra })
const send = (res, body) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)) }
const briefs = [record, thin].map(item => ({ id: `ses_brief_${item.id}`, item }))
const preview = await startAttentionPreview([{
  name: "visual-brief-fixture",
  configureServer(server) {
    server.middlewares.use("/oc/session", (req, res, next) => {
      const [, id, tail] = new URL(req.url, "http://preview").pathname.split("/")
      if (id?.startsWith("ses_fdbrief_") && !tail) return send(res, session(id, { time: { created: now, updated: now, archived: now } }))
      if (id?.startsWith("ses_fdbrief_") && tail === "children") return send(res, briefs.map(brief => session(brief.id, { parentID: id, metadata: { frontDesk: {
        kind: "brief", requestID: brief.id, source: `attention:fixture:${brief.item.id}`, revision: String(brief.item.revision), title: brief.item.title, refs, ...(old ? {} : { contract: 2 }) } } })))
      const brief = briefs.find(item => item.id === id)
      if (brief && tail === "message") return send(res, [message("msg_user", id, "user", "packet"), message("msg_reply", id, "assistant", JSON.stringify(results[brief.item.id]))])
      next()
    })
  },
}])
preview.fixture.editspaces = [{ name: "fixture", root: directory }]
let failed = false
const browser = await chromium.launch({ channel: "chrome", headless: true })
try {
  const open = async (viewport, id, rtl = false) => {
    const context = await browser.newContext({ viewport })
    await context.addInitScript(() => { localStorage.setItem("es-app-all-projects", "true"); localStorage.setItem("es-app:front-desk:auto-prepare", "off") })
    await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
    const page = await context.newPage()
    page.on("pageerror", error => console.error(`pageerror: ${error.message}`))
    await page.goto(`${preview.origin}/?item=${encodeURIComponent(`attention:fixture:${id}`)}`)
    if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
    return page
  }
  // The ledger fixture's own records are replaced by the two under test.
  preview.ledger.records.splice(0, preview.ledger.records.length, record, thin)

  const page = await open({ width: 1440, height: 1000 }, "probe")
  const card = page.locator('[data-attention-id="probe"]')
  if (old) {
    await card.locator(".desk-brief-ask").waitFor({ timeout: 30_000 })
    if (shots) await page.screenshot({ path: path.join(shots, "before.png") })
  } else {
    await expect(card.locator(".desk-brief-why")).toContainText("Why you: It pushes branches and runs build jobs with managed credentials.", { timeout: 30_000 })
    await expect(card.locator(".desk-brief-why")).toContainText("Why now: Worker CPU is ~9x baseline")
    await expect(card.locator(".desk-brief-ask")).toHaveCount(0)
    // The cards are the one option list: labels, IDs and the radio names stay the producer's.
    await expect(card.getByRole("radio")).toHaveCount(3)
    const cards = card.locator(".home-option-card")
    await expect(cards).toHaveCount(3)
    await expect(cards.first()).toContainText("Six runs test whether storage reads are the cause")
    await expect(cards.first().locator(".home-option-chips")).toHaveText("Recommendedread-only~60-90 min")
    await expect(cards.first().locator(".home-option-risk")).toHaveText("− Tests one theory, not the whole fix")
    await expect(card.locator(".home-option-wait")).toHaveCount(0)
    await expect(card.locator(".desk-scope")).toContainText("Deploys or prod writes")
    await expect(card.locator(".desk-brief-unknown")).toHaveText("Unknown Whether the build node can read the stage bucket.")
    // Sources open real destinations; one with no resolvable ref is dropped.
    const sources = card.locator(".desk-brief-sources a")
    // The request's own thread is already "Open thread"; the unresolvable one is dropped too.
    await expect(sources).toHaveCount(1)
    assert.match(await sources.first().getAttribute("href"), /^\/session\/ses_a\?directory=.*&message=msg_e1$/)
    await expect(sources.first()).toHaveText("↗ Thread · Harness readiness report")
    // Evidence, claims and the request's own text are one click away.
    await expect(card.locator(".home-original p")).toBeHidden()
    await expect(card.locator(".desk-brief-detail li").first()).toBeHidden()
    await expect(card.locator(".desk-ref")).toHaveCount(2)
    await expect(card.locator(".desk-ref").first()).toBeHidden()
    const probe = card.getByRole("radio", { name: record.options[0].label, exact: true })
    await probe.check()
    const send = card.getByRole("button", { name: `Send ${record.options[0].label}`, exact: true })
    await expect(send).toBeVisible()
    await expect(send).toHaveText("Send")
    // First viewport at 1440x1000 holds the decision through Send, in a short card.
    const box = await send.boundingBox()
    const words = await card.evaluate(element => {
      const copy = element.cloneNode(true)
      copy.querySelectorAll("details").forEach(item => item.remove())
      document.body.append(copy)
      const count = copy.innerText.split(/\s+/).filter(Boolean).length
      copy.remove()
      return count
    })
    if (shots) await page.screenshot({ path: path.join(shots, "after.png") })
    assert(box && box.y + box.height <= 1000, `Send at ${JSON.stringify(box)}`)
    // The producer's three long option labels (and the Send label repeating one) are about 50 of these words.
    assert(words <= 190, `words above Details ${words}`)
    console.log(`VISUAL probe: why line, 3 outcome cards, scope, unknown, 1 source; Send bottom ${Math.round(box.y + box.height)}px; ${words} words above Details`)

    // More detail: an explicit question goes to the desk chat bound to this item and revision, with
    // citable links; the chat draft and the selection stay as they were.
    await page.getByRole("button", { name: "Start chat" }).click()
    const editor = page.locator(".desk-chat .prompt-box textarea")
    await editor.fill("draft I am still writing")
    const asks = []
    page.on("request", request => { if (request.method() === "POST" && request.url().includes("/prompt_async")) asks.push(JSON.parse(request.postData())) })
    await card.getByRole("button", { name: "More detail" }).click()
    await card.getByRole("textbox", { name: "Question for the front desk (optional)" }).fill("Why only writes?")
    if (shots) await page.screenshot({ path: path.join(shots, "more-detail.png") })
    await card.getByRole("button", { name: "Ask" }).click()
    await expect(card.locator(".desk-more")).toContainText("Asked in the chat.")
    assert.equal(asks.length, 1)
    assert.equal(asks[0].parts[0].text, `More detail: ${record.title}\n\nWhy only writes?`)
    const evidence = asks[0].parts.find(part => part.metadata?.source === "es-app/front-desk-detail")
    assert(evidence?.synthetic && evidence.text.includes("attention:fixture:probe at revision 4") && /-> \/session\/ses_a\?directory=.*&message=msg_/.test(evidence.text), evidence?.text)
    await expect(editor).toHaveValue("draft I am still writing")
    await expect(page.locator('.desk-item[aria-pressed="true"]')).toContainText("Worker CPU")
    await page.waitForTimeout(1000)
    assert.equal(asks.length, 1, "no repeat send on re-render")
    if (shots) await page.screenshot({ path: path.join(shots, "more-detail-asked.png") })
    console.log("MORE DETAIL explicit ask -> one desk message bound to item rev 4 with message links; draft and selection kept")

    // Without outcomes for every option the brief does not stand in: plain radios and the request as written.
    const thinPage = await open({ width: 1440, height: 1000 }, "thin")
    const thinCard = thinPage.locator('[data-attention-id="thin"]')
    await expect(thinCard.locator(".desk-brief-detail")).toHaveCount(1, { timeout: 30_000 })
    await expect(thinCard).toContainText("The table name collides with a new view.")
    await expect(thinCard.locator(".desk-brief-why, .desk-brief-ask, .home-option-card")).toHaveCount(0)
    await expect(thinCard.getByRole("radio")).toHaveCount(2)
    console.log("HONEST incomplete brief -> plain radios + request as written")

    if (shots) {
      const narrow = await open({ width: 390, height: 1400 }, "probe")
      await narrow.locator('[data-attention-id="probe"] .home-option-card').first().waitFor({ timeout: 30_000 })
      await narrow.screenshot({ path: path.join(shots, "after-mobile.png"), fullPage: true })
    }
    // Narrow RTL: cards and scope stack, nothing scrolls sideways.
    const mobile = await open({ width: 390, height: 2000 }, "probe", true)
    await expect(mobile.locator('[data-attention-id="probe"] .home-option-card')).toHaveCount(3, { timeout: 30_000 })
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal scroll")
    if (shots) await mobile.screenshot({ path: path.join(shots, "after-rtl-mobile.png"), fullPage: true })
    console.log("RTL mobile: no horizontal scroll")
  }
  console.log("DESK BRIEF VISUAL: PASS")
} catch (error) {
  failed = true
  console.error(error)
} finally {
  await browser.close()
  await preview.close()
  process.exit(failed ? 1 : 0)
}
