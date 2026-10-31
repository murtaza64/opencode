// Rating a brief from its Details: Good / Neutral / Bad plus an optional note, sent for the brief shown (its job),
// never the decision. Rating leaves the chosen option, the answer note and Send as they were and sends no attention
// command; unrated shows no rating pressed (not Neutral); a reload shows the saved rating; pressing it again clears.
// Synthetic fixture: hand-written brief, in-memory feedback store standing in for the dashboard route.
// Run from packages/es-app: node test/brief-feedback.browser.mjs
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const now = Date.now()
const JOB = "ses_fdjob_" + "f".repeat(24)
const record = { id: "fb", editspace: "fixture", status: "open", kind: "decision", producer_session: "ses_a", origin_session: "ses_a",
  source_ref: { session_id: "ses_a", directory }, decision: null, delivery_state: "not-requested", updated_at: now, snoozed_until: null,
  revision: 1, created_at: now - 300_000, gate_key: "fb:v1", lane: "rollout", title: "Roll out the cache change?", context: "Canary is healthy for a day.",
  options: [{ id: "full", label: "Roll out to everyone" }, { id: "wait", label: "Stay at canary" }], recommendation: "full" }
const refs = [{ id: "C1", label: "canonical decision" }]
const result = { question: "Roll the cache change out to everyone?", context: "The canary has been healthy for a day.",
  choices: [{ id: "full", outcome: "Everyone gets the faster cache" }, { id: "wait", outcome: "Only the canary has it" }], facts: [{ text: "Canary healthy for a day", refs: ["C1"] }] }
const message = (id, sessionID, role, text) => ({
  info: { id, sessionID, role, time: { created: now - 60_000, ...(role === "assistant" ? { completed: now - 30_000 } : {}) }, ...(role === "assistant" ? { modelID: "fixture", providerID: "fixture", mode: "build", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, parentID: "msg_user" } : { agent: "build", model: { providerID: "fixture", modelID: "fixture" } }) },
  parts: [{ id: `${id}_part`, sessionID, messageID: id, type: "text", text }],
})
const session = (id, extra = {}) => ({ id, slug: id, projectID: "fixture", directory, title: id, version: "1", time: { created: now - 120_000, updated: now - 30_000 }, ...extra })
const send = (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)) }
const read = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null }
// What the stand-in dashboard saw.
const store = { entry: null, posts: [] }
const preview = await startAttentionPreview([{
  name: "brief-feedback-fixture",
  configureServer(server) {
    server.middlewares.use("/es/api/frontdesk/conversation", (_req, res) => send(res, { threads: [] }))
    server.middlewares.use("/es/api/frontdesk/brief-feedback", async (req, res) => {
      if (req.method === "POST") {
        const body = await read(req)
        store.posts.push({ body, csrf: req.headers["x-attention-csrf"] })
        store.entry = { job: body.job, directory: body.directory, source: "attention:fixture:fb", revision: "1", contract: 4, model: "fixture", rating: body.rating, text: body.text, at: Date.now(), host: "fixture", history: [] }
        return send(res, { entry: store.entry })
      }
      return send(res, { entry: new URL(req.url, "http://preview").searchParams.get("job") === JOB ? store.entry : null })
    })
    server.middlewares.use("/oc/session", (req, res, next) => {
      const [, id, tail] = new URL(req.url, "http://preview").pathname.split("/")
      if (id?.startsWith("ses_fdbrief_") && !tail) return send(res, session(id, { time: { created: now, updated: now, archived: now } }))
      if (id?.startsWith("ses_fdbrief_") && tail === "children") return send(res, [session(JOB, { parentID: id, metadata: { frontDesk: {
        kind: "brief", requestID: "r", source: "attention:fixture:fb", revision: "1", title: record.title, refs, contract: 4 } } })])
      if (id === JOB && tail === "message") return send(res, [message("msg_user", id, "user", "packet"), message("msg_reply", id, "assistant", JSON.stringify(result))])
      next()
    })
  },
}])
preview.fixture.editspaces = [{ name: "fixture", root: directory }]
let failed = false
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.addInitScript(() => { try { localStorage.setItem("es-app-all-projects", "true"); localStorage.setItem("es-app:front-desk:auto-prepare", "off") } catch {} })
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
page.setDefaultNavigationTimeout(300_000)
page.setDefaultTimeout(90_000)
page.on("pageerror", error => console.error(`pageerror: ${error.message}`))
const card = page.locator('[data-attention-id="fb"]')
const group = card.getByRole("group", { name: "Rate this brief" })
const openDetails = async () => { await card.locator("details.home-details > summary").click(); await expect(group).toBeVisible() }
// The answer controls as the human left them: chosen option, note, Send state.
const answerState = () => card.evaluate(element => ({
  checked: [...element.querySelectorAll('input[type="radio"]')].map(input => input.checked),
  note: [...element.querySelectorAll("textarea")].filter(area => !area.closest(".desk-brief-feedback")).map(area => area.value),
  send: element.querySelector("button.home-primary")?.disabled,
}))
const attentionCommands = () => preview.ledger.calls.filter(call => call.method === "POST" && call.path.includes("/commands"))
try {
  preview.ledger.records.splice(0, preview.ledger.records.length, record)
  await page.goto(`${preview.origin}/?item=${encodeURIComponent("attention:fixture:fb")}`)
  await expect(card.locator("h3.home-question")).toHaveText("Roll the cache change out to everyone?", { timeout: 120_000 })
  await card.getByRole("radio", { name: "Stay at canary", exact: true }).check()
  await card.locator("textarea").first().fill("checked the dashboard")
  const before = await answerState()
  const commandsBefore = attentionCommands().length

  // Unrated: no rating pressed, and no note box until a rating is chosen.
  await openDetails()
  for (const name of ["Good", "Neutral", "Bad"]) await expect(group.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false")
  await expect(group.locator("textarea")).toHaveCount(0)

  // Rate Bad, then add a note: both sent for this brief only, and the answer is untouched.
  await group.getByRole("button", { name: "Bad" }).click()
  await expect(group.getByRole("button", { name: "Bad" })).toHaveAttribute("aria-pressed", "true")
  await group.locator("textarea").fill("It skipped the rollback cost")
  await group.getByRole("button", { name: "Save note" }).click()
  await expect(group.getByRole("status")).toHaveText("Saved")
  assert.deepEqual(store.posts.map(post => post.body), [
    { job: JOB, directory, rating: "bad", text: "" },
    { job: JOB, directory, rating: "bad", text: "It skipped the rollback cost" },
  ])
  assert(store.posts.every(post => post.csrf === "1"))
  assert.deepEqual(await answerState(), before)
  assert.equal(attentionCommands().length, commandsBefore)
  console.log("RATED: Bad + note sent for the brief job only; option, answer note and Send unchanged; no attention command")

  // Reload: the saved rating and note come back.
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(card.locator("h3.home-question")).toBeVisible({ timeout: 120_000 })
  await openDetails()
  await expect(group.getByRole("button", { name: "Bad" })).toHaveAttribute("aria-pressed", "true")
  await expect(group.locator("textarea")).toHaveValue("It skipped the rollback cost")

  // Pressing the chosen rating again clears it (unrated, not Neutral).
  await group.getByRole("button", { name: "Bad" }).click()
  await expect.poll(() => store.posts.at(-1).body.rating).toBe(null)
  for (const name of ["Good", "Neutral", "Bad"]) await expect(group.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false")
  assert.equal(attentionCommands().length, commandsBefore)
  console.log("RELOAD shows the saved rating and note; pressing it again clears to unrated")
} catch (error) {
  failed = true
  console.error(error)
} finally {
  await browser.close()
  await preview.close()
}
if (failed) process.exit(1)
console.log("PASS brief-feedback")
