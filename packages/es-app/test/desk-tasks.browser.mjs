// Desk chat background tasks (Dot slice 1): "Ask in background" records the question as the human's own
// message, shows a receipt at once and leaves the chat free; a second exchange is admitted while the task
// works; a follow-up reaches the running task as steer input; the result reaches the asking conversation
// once (queue), across a selection change, a reload and a second client; a newer desk conversation lists
// the task without receiving its result. Disposable in-memory Core stand-in; no model, no real content.
// The UI appears only when Core advertises noReplyRecordOnly (no reply to a no-reply message, even mid-turn);
// the stand-in Core advertises it.
// Run from packages/es-app: node test/desk-tasks.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined

// What the stand-in Core saw.
const core = { tasks: new Map(), deskMessages: [], deskInputs: [], taskPrompts: [], taskInputs: [], conflicts: 0, finished: false, finishedAt: 0, deskBusy: false }
const now = Date.now()
const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)) }
const read = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null }
const message = (id, sessionID, role, text) => ({
  info: { id, sessionID, role, time: { created: now, ...(role === "assistant" ? { completed: core.finishedAt } : {}) }, ...(role === "assistant" ? { modelID: "fixture", providerID: "fixture", mode: "build", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, parentID: "msg_task_user" } : { agent: "build", model: { providerID: "fixture", modelID: "fixture" } }) },
  parts: [{ id: `${id}_part`, sessionID, messageID: id, type: "text", text }],
})
// Core reconciles an input by requestID against the exact session and payload: the same is one input, a different one conflicts.
const admit = (list, session, body) => {
  const same = list.find(item => item.body.requestID === body.requestID)
  if (same && (same.session !== session || JSON.stringify(same.body) !== JSON.stringify(body))) { core.conflicts++; return 409 }
  if (!same) list.push({ session, body, at: Date.now() })
  return 200
}
const preview = await startAttentionPreview([{
  name: "desk-tasks-fixture",
  configureServer(server) {
    server.middlewares.use("/es/api/frontdesk/model", (_req, res) => json(res, { model: { providerID: "fixture", modelID: "fixture" }, available: true, reason: "" }))
    server.middlewares.use("/oc/session", async (req, res, next) => {
      const url = new URL(req.url, "http://preview")
      const [, id, tail, sub] = url.pathname.split("/")
      if (url.pathname === "/status") return json(res, { ses_a: { type: core.deskBusy ? "busy" : "idle" }, ses_b: { type: "idle" }, ...Object.fromEntries([...core.tasks.keys()].map(task => [task, { type: core.finished ? "idle" : "busy" }])) })
      if (url.pathname === "/" && req.method === "POST") {
        const body = await read(req)
        if (!body?.id?.startsWith("ses_fdtask_")) return json(res, { error: "unexpected create" }, 400)
        if (!core.tasks.has(body.id)) core.tasks.set(body.id, { session: { id: body.id, slug: body.id, projectID: "fixture", directory, title: body.title, version: "1", parentID: body.parentID, metadata: body.metadata, permission: body.permission, time: { created: Date.now(), updated: Date.now() } } })
        return json(res, core.tasks.get(body.id).session)
      }
      if (id?.startsWith("ses_fdbrief_") && !tail) return json(res, { id, slug: id, projectID: "fixture", directory, title: "Front desk briefs", version: "1", time: { created: now, updated: now, archived: now } })
      if (id?.startsWith("ses_fdbrief_") && tail === "children") return json(res, [...core.tasks.values()].map(task => task.session))
      if (id?.startsWith("ses_fdtask_")) {
        const task = core.tasks.get(id)
        if (!task) return json(res, { name: "NotFoundError" }, 404)
        if (!tail) return json(res, task.session)
        if (tail === "prompt_async" && req.method === "POST") { core.taskPrompts.push({ id, body: await read(req) }); res.writeHead(204); return res.end() }
        if (tail === "input" && req.method === "POST") { const body = await read(req); return json(res, { ...body, state: "pending" }, admit(core.taskInputs, id, body)) }
        if (tail === "message") return json(res, [message("msg_task_user", id, "user", "packet"), ...(core.finished ? [message("msg_task_done", id, "assistant", "Build 42 is on the Mini (see deploy.md).")] : [])])
        return json(res, [])
      }
      // The desk conversations (ses_a, later ses_b): the question as a no-reply message, and inputs.
      if ((id === "ses_a" || id === "ses_b") && tail === "prompt_async" && req.method === "POST") { core.deskMessages.push({ id, body: await read(req), at: Date.now() }); res.writeHead(204); return res.end() }
      if ((id === "ses_a" || id === "ses_b") && tail === "input" && !sub && req.method === "POST") {
        const body = await read(req)
        return json(res, { ...body, sessionID: id, state: "pending", timeCreated: Date.now(), admittedSeq: core.deskInputs.length + 1, agent: "build" }, admit(core.deskInputs, id, body))
      }
      next()
    })
  },
}])
preview.fixture.permissions = []
// The desk conversation's transcript, which the stand-in desk model answers into.
preview.fixture.messages = []
preview.fixture.noReplyRecordOnly = true
const deskTurn = (role, id, text, extra = {}) => {
  const info = { id, sessionID: "ses_a", role, time: { created: Date.now(), ...(role === "assistant" ? { completed: Date.now() } : {}) }, agent: role === "assistant" ? (extra.mode ?? "build") : "build",
    model: { providerID: "fixture", modelID: "test" }, ...(role === "assistant" ? { parentID: "msg_desk_q2", providerID: "fixture", modelID: "test", mode: extra.mode ?? "build", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } : {}) }
  const part = { id: `prt_${id}`, sessionID: "ses_a", messageID: id, type: "text", text }
  preview.fixture.messages.push({ info, parts: text ? [part] : [] })
  preview.fixture.emit("message.updated", { info })
  if (text) preview.fixture.emit("message.part.updated", { part })
}
preview.fixture.editspaces = [{ name: "fixture", root: directory }]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const open = async (desk = "ses_a", context) => {
  context ??= await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(value => { if (window === window.top) { localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)); localStorage.setItem("es-app:front-desk:auto-prepare", "off") } }, { session: desk, directory })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(90_000)
  page.on("pageerror", error => console.error(`pageerror: ${error.message}`))
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(page.locator(".desk-chat textarea")).toBeVisible({ timeout: 300_000 })
  return { page, context }
}
const results = () => core.deskInputs.filter(item => item.body.requestID.startsWith("fdtask-result:"))
const metrics = page => page.evaluate(() => JSON.parse(localStorage.getItem("es-app:front-desk:task-metrics:1") ?? "[]"))
// An earlier ordinary exchange: a desk with only no-reply messages would be answered on its next wake.
deskTurn("user", "msg_desk_q1", "Morning, anything new?")
deskTurn("assistant", "msg_desk_a1", "Nothing new since yesterday.")
let failed = false
try {
  const { page, context } = await open()
  const composer = page.locator(".desk-chat textarea")
  const chip = page.locator(".desk-task")

  // 1. Receipt: the question becomes the human's message and a task with that identity; the chat box empties.
  await composer.fill("Which build is on the Mini?")
  await page.getByRole("button", { name: "Ask in background" }).click()
  // The echo is on screen before Core answers anything.
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText(/sending|registered|working/)
  await expect(composer).toHaveValue("")
  await expect.poll(() => core.taskPrompts.length).toBe(1)
  const [asked] = core.deskMessages
  assert.equal(asked.id, "ses_a")
  assert.equal(asked.body.noReply, true)
  assert.match(asked.body.messageID, /^msg_/)
  assert.equal(asked.body.parts[0].text, "Background check: Which build is on the Mini?")
  const [task] = [...core.tasks.values()]
  const meta = task.session.metadata.frontDesk
  assert.deepEqual([meta.kind, meta.requestID, meta.initiatingSession, meta.contract], ["task", asked.body.messageID, "ses_a", 1])
  assert.match(meta.packetSha256, /^[0-9a-f]{64}$/)
  assert.equal(task.session.permission[0].permission, "*")
  assert.equal(task.session.permission[0].action, "deny")
  // The packet is the question plus the desk's view, not the conversation.
  assert.match(core.taskPrompts[0].body.parts[0].text, /^Question: Which build is on the Mini\?\n/)
  await expect(chip).toContainText("working")
  await expect.poll(async () => (await metrics(page)).find(item => item.task === task.session.id)?.ackMs).toBeLessThan(5000)
  const ack = (await metrics(page)).find(item => item.task === task.session.id)
  console.log(`RECEIPT shown ${ack.ackMs} ms after Ask; packet ${ack.packetBytes} bytes; question recorded as a no-reply desk message`)

  // 2. Second exchange while the task works: an ordinary send is admitted to the desk at once.
  const sentAt = Date.now()
  await composer.fill("Meanwhile, what is waiting for me?")
  await page.locator(".desk-chat").getByRole("button", { name: "Send", exact: true }).click()
  // The composer sends through Core's input admission or prompt route, whichever this build uses.
  const sentSecond = () => core.deskInputs.find(item => item.body.text === "Meanwhile, what is waiting for me?")
    ?? core.deskMessages.find(item => !item.body.noReply && item.body.parts?.some(part => part.text === "Meanwhile, what is waiting for me?"))
  await expect.poll(() => !!sentSecond(), { timeout: 15_000 }).toBe(true)
  const second = sentSecond()
  assert.equal(results().length, 0)
  // The desk answers it while the task is still held working: the reply is in the transcript and the task is untouched.
  deskTurn("user", "msg_desk_q2", "Meanwhile, what is waiting for me?")
  deskTurn("assistant", "msg_desk_a2", "One decision is waiting: the bounded implementation scope.")
  await expect(page.locator(".desk-chat")).toContainText("One decision is waiting: the bounded implementation scope.")
  const answeredAt = Date.now()
  await expect(chip).toContainText("working")
  assert.equal(core.finished, false)
  assert.equal(core.taskPrompts.length, 1)
  console.log(`SECOND EXCHANGE admitted ${second.at - sentAt} ms after Send and its desk reply shown ${answeredAt - sentAt} ms after Send, while the task stayed working (stand-in desk reply)`)

  // 3. Follow-up to the running task: recorded in the chat, then steer input to the same task session.
  await composer.fill("Also check the laptop")
  await chip.getByRole("button", { name: "Add to this task" }).click()
  await expect.poll(() => core.taskInputs.length).toBe(1)
  const [follow] = core.taskInputs
  assert.equal(follow.session, task.session.id)
  assert.equal(follow.body.delivery, "steer")
  assert.equal(follow.body.text, "Also check the laptop")
  const amendMessage = core.deskMessages.at(-1)
  assert.equal(follow.body.requestID, `fdtask-amend:${amendMessage.body.messageID}`)
  assert.equal(amendMessage.body.noReply, true)
  assert.deepEqual([follow.body.source.sender, follow.body.source.senderSession, follow.body.source.in_reply_to, follow.body.source.relationship], ["ses_a", "ses_a", amendMessage.body.messageID, "front-desk-task"])
  await expect(composer).toHaveValue("")
  console.log("FOLLOW-UP steer input to the running task, keyed by its own desk message")

  // 4. Selection change, then the task finishes: one queue input to the asking conversation.
  await page.locator('[data-attention-id], .desk-queue button, .desk-item').first().click().catch(() => undefined)
  // Manual compaction of the desk conversation before the task ends: the result still goes to the same session.
  deskTurn("assistant", "msg_desk_compaction", "", { mode: "compaction" })
  core.finishedAt = Date.now()
  core.finished = true
  await expect.poll(() => results().length, { timeout: 30_000 }).toBe(1)
  const [result] = results()
  assert.equal(result.session, "ses_a")
  assert.equal(result.body.delivery, "queue")
  assert.equal(result.body.requestID, `fdtask-result:${task.session.id}`)
  assert.match(result.body.text, /Build 42 is on the Mini/)
  assert.deepEqual(result.body.source, { type: "editspace-mail", id: result.body.requestID, sender: task.session.id, recipient: "ses_a", kind: "task-result",
    senderSession: task.session.id, relationship: "front-desk-task", in_reply_to: asked.body.messageID })
  await expect(chip).toContainText("outcome")
  if (shots) await page.screenshot({ path: path.join(shots, "tasks-outcome.png") })
  const delivered = (await metrics(page)).find(item => item.task === task.session.id)
  console.log(`RESULT one queue input to ses_a after a selection change and a desk compaction; completion to delivered ${delivered.deliveredMs} ms`)

  // 5. Reload, and a second tab that has no record of the delivery: still one input, never a conflicting one.
  // (A device that never started a task does not read them; its delivery is the headless dashboard's, not built yet.)
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator(".desk-task")).toContainText("outcome")
  const other = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await other.addInitScript(() => { if (window === window.top) localStorage.setItem("es-app:front-desk:tasks-used:1", "1") })
  const second_client = await open("ses_a", other)
  await expect(second_client.page.locator(".desk-task")).toHaveCount(1)
  await second_client.page.waitForTimeout(2000)
  assert.equal(results().length, 1)
  assert.equal(core.conflicts, 0)
  console.log("RELOAD + SECOND TAB without the delivery record: same requestID and payload, one input, no conflict")
  await other.close()

  // 6. A newer desk conversation lists the task as earlier and never receives its result.
  await context.close()
  const later = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await later.addInitScript(() => { if (window === window.top) localStorage.setItem("es-app:front-desk:tasks-used:1", "1") })
  const adopted = await open("ses_b", later)
  await expect(adopted.page.locator(".desk-task")).toContainText("asked in an earlier conversation")
  await adopted.page.waitForTimeout(2000)
  assert.equal(core.deskInputs.filter(item => item.session === "ses_b").length, 0)
  assert.equal(results().length, 1)
  console.log("ADOPTION: newer desk lists the task by reference; no second result input")
  await adopted.context.close()

  // 7. A Core without noReplyRecordOnly (it would answer the recorded question mid-turn): no background tasks.
  preview.fixture.noReplyRecordOnly = false
  const old = await open("ses_a")
  await old.page.waitForTimeout(2000)
  await expect(old.page.getByRole("button", { name: "Ask in background" })).toHaveCount(0)
  console.log("OLD CORE: no noReplyRecordOnly capability, so Ask in background is not offered")
  await old.context.close()
} catch (error) {
  failed = true
  console.error(error)
} finally {
  await browser.close()
  await preview.close()
}
if (failed) process.exit(1)
console.log("PASS desk-tasks")
