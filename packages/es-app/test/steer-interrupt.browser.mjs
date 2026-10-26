// A steer sent while a long tool runs says what it waits on and offers "Interrupt and steer now": one request
// stops the tool (its partial output stays, marked interrupted) and starts the next turn with the steer.
// No Stop, no resend, no second prompt; the draft and other pending inputs are untouched. A steer left
// pending after Stop offers "Steer now". Without the server capability, only the reason is shown.
// Run from packages/es-app: node test/steer-interrupt.browser.mjs   (STEER_SHOTS=<dir> for screenshots)
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.interruptInput = true
const started = Date.now() - 3 * 60_000
const bash = {
  id: "part_bash", messageID: "msg_2", sessionID: "ses_a", type: "tool", callID: "call_bash", tool: "bash",
  state: { status: "running", input: { command: "bun run build:all", description: "Full build" }, title: "bun run build:all",
    time: { start: started }, metadata: { output: "partial-build-output: compiled 412/980 modules" } },
}
fixture.messages[1].parts.push(bash)
fixture.receipts.push({ requestID: "q-later", sessionID: "ses_a", delivery: "queue", text: "afterwards, update the changelog",
  agent: "build", admittedSeq: 1, timeCreated: Date.now(), state: "pending" })

const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const editor = page.getByRole("textbox", { name: "Message", exact: true })
const bubble = (id) => page.locator(`.outgoing li[data-request-id="${id}"]`)
const steerPosts = () => fixture.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/input")
const delivers = () => fixture.calls.filter((call) => call.method === "POST" && /\/session\/ses_a\/input\/[^/]+\/deliver$/.test(call.path))
const forbidden = () => fixture.calls.filter((call) => call.method === "POST" && /\/(abort|prompt_async)$/.test(call.path))
const bashCard = page.locator('[data-component="tool-part-wrapper"][data-tool="bash"]')
const users = (text) => page.locator('[data-component="user-message"]').filter({ hasText: text })
const shot = async (name) => { if (process.env.STEER_SHOTS) await page.screenshot({ path: `${process.env.STEER_SHOTS}/${name}.png` }) }
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.locator(".session-work-status:visible")).toHaveAttribute("data-state", "working")
  await expect(bashCard).toHaveAttribute("data-status", "running")

  // 1. Steer while the build runs: the bubble says what it waits on and for how long.
  await editor.fill("stop the full build, only rebuild es-app")
  await page.getByRole("button", { name: "Steer", exact: true }).click()
  await expect.poll(() => steerPosts().length).toBe(1)
  const id = steerPosts()[0].body.requestID
  await expect(bubble(id).locator(".outgoing-cue > span")).toHaveText(/^Steer · waiting for bash to finish · [3-9]m$/)
  await expect(editor).toHaveValue("")
  const deliver = bubble(id).getByRole("button", { name: /^Interrupt and steer now:/ })
  await expect(deliver).toHaveText("Interrupt and steer now")
  await expect(deliver).toHaveAttribute("title", /Stops bash \(its output so far is kept\).*Nothing is rerun/)
  await expect(bubble("q-later").locator(".outgoing-cue > span")).toHaveText("Queued · after this task")
  await expect(bubble("q-later").getByRole("button", { name: /steer now/i })).toHaveCount(0)
  await shot("1-waiting")
  console.info("PASS steer during a long tool: cue names the running tool and its age; Interrupt and steer now offered on the steer only")

  // 2. Interrupt and steer now: one request; the tool stops with its partial output, the steer starts the next turn.
  await editor.fill("unrelated draft in progress")
  fixture.holdDeliver = true
  await deliver.click()
  await expect(deliver).toHaveText("Steering…")
  await expect(deliver).toBeDisabled()
  fixture.holdDeliver = false
  fixture.deliverReplies.splice(0).forEach((reply) => reply())
  await expect(bubble(id)).toHaveCount(0)
  await expect(page.locator('[data-component="user-message"]').last()).toContainText("stop the full build, only rebuild es-app")
  await expect(bashCard).toHaveAttribute("data-status", "completed")
  await expect(bashCard).toContainText("Interrupted")
  await bashCard.getByText("Interrupted").click()
  await expect(bashCard.locator('[data-component="bash-output"]')).toContainText("partial-build-output: compiled 412/980 modules")
  await expect(bashCard).not.toContainText("shell_metadata")
  await expect(editor).toHaveValue("unrelated draft in progress")
  await expect(bubble("q-later").locator(".outgoing-cue > span")).toHaveText("Queued · after this task")
  await expect(page.locator(".session-work-status:visible")).toHaveAttribute("data-state", "working")
  expect(delivers().map((call) => decodeURIComponent(call.path.split("/").at(-2)))).toEqual([id])
  expect(forbidden()).toEqual([])
  expect(steerPosts()).toHaveLength(1)
  expect(fixture.receipts.find((item) => item.requestID === id)).toMatchObject({ state: "promoted", messageID: `msg_steer_${id}` })
  await shot("2-delivered")
  console.info("PASS Interrupt and steer now: one deliver request, no abort/prompt/resend; tool interrupted with partial output; steer is the next user message; draft and queued input kept")

  // 3. A steer left pending after Stop is delivered with one click, not retyped.
  await page.getByRole("button", { name: "Stop session", exact: true }).click()
  await expect(page.locator(".session-work-status:visible")).toHaveAttribute("data-state", "idle")
  fixture.receipts.push({ requestID: "s-stranded", sessionID: "ses_a", delivery: "steer", text: "then run only the es-app tests",
    agent: "build", admittedSeq: 3, timeCreated: Date.now(), state: "pending" })
  fixture.emit("session.input.updated", { sessionID: "ses_a" })
  await expect(bubble("s-stranded").locator(".outgoing-cue > span")).toHaveText("Steer · not delivered; the session stopped")
  const now = bubble("s-stranded").getByRole("button", { name: /^Steer now:/ })
  await expect(now).toHaveText("Steer now")
  await now.click()
  await expect(bubble("s-stranded")).toHaveCount(0)
  await expect(page.locator('[data-component="user-message"]').last()).toContainText("then run only the es-app tests")
  expect(steerPosts()).toHaveLength(1)
  expect(forbidden().filter((call) => call.path.endsWith("/prompt_async"))).toEqual([])
  console.info("PASS steer stranded by Stop: Steer now starts a turn with it under its own request ID; nothing retyped")

  // 4. Older server without the capability: the reason is shown, no button that would fail.
  fixture.interruptInput = false
  fixture.setStatus("busy")
  const last = fixture.messages.at(-1).info
  fixture.messages.push({
    info: { ...fixture.messages[1].info, id: "msg_turn_3", parentID: last.id, time: { created: Date.now() }, error: undefined },
    parts: [{ ...bash, id: "part_bash_2", messageID: "msg_turn_3", callID: "call_bash_2",
      state: { status: "running", input: { command: "bun test" }, title: "bun test", time: { start: Date.now() }, metadata: {} } }],
  })
  fixture.receipts.push({ requestID: "s-old", sessionID: "ses_a", delivery: "steer", text: "steer on an older server",
    agent: "build", admittedSeq: 4, timeCreated: Date.now(), state: "pending" })
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(bubble("s-old").locator(".outgoing-cue > span")).toHaveText("Steer · waiting for bash to finish")
  await expect(bubble("s-old").getByRole("button", { name: /steer now/i })).toHaveCount(0)
  console.info("PASS without server support: waiting reason only, no deliver action")

  // 5. The reported state: busy without a running tool, footer "Steer · at the next safe point  Edit  Cancel".
  // One click interrupts and delivers that same edited steer under its request ID.
  fixture.interruptInput = true
  fixture.updateInput = true
  const turn = fixture.messages.find((message) => message.info.id === "msg_turn_3")
  turn.parts[0].state = { ...turn.parts[0].state, status: "completed", output: "ok", time: { start: Date.now() - 1000, end: Date.now() } }
  Object.assign(fixture.receipts.find((item) => item.requestID === "s-old"), { state: "cancelled" })
  fixture.receipts.push({ requestID: "s-edit", sessionID: "ses_a", delivery: "steer", text: "steer, edited before delivery",
    agent: "build", admittedSeq: 5, timeCreated: Date.now(), state: "pending", revision: 1 })
  await page.reload({ waitUntil: "domcontentloaded" })
  const footer = bubble("s-edit").locator(".outgoing-cue")
  await expect(footer.locator("> span")).toHaveText("Steer · at the next safe point")
  await expect(footer.getByRole("button")).toHaveText(["Interrupt and steer now", "Edit", "Cancel"])
  await shot("5-reported-state")
  const before = delivers().length
  const stops = forbidden().length
  await footer.getByRole("button", { name: "Interrupt and steer now: steer, edited before delivery" }).click()
  await expect(bubble("s-edit")).toHaveCount(0)
  await expect(users("steer, edited before delivery")).toHaveCount(1)
  expect(delivers().length).toBe(before + 1)
  expect(fixture.receipts.find((item) => item.requestID === "s-edit")).toMatchObject({ state: "promoted", revision: 1 })
  expect(steerPosts()).toHaveLength(1)
  expect(forbidden()).toHaveLength(stops)
  console.info("PASS reported state: Interrupt and steer now beside Edit/Cancel; one click delivers the same edited steer by request ID")

  // 6. Race: the steer reached a natural boundary before the click took effect -> settled, no second message.
  fixture.receipts.push({ requestID: "s-race", sessionID: "ses_a", delivery: "steer", text: "steer that wins the race",
    agent: "build", admittedSeq: 6, timeCreated: Date.now(), state: "pending" })
  fixture.emit("session.input.updated", { sessionID: "ses_a" })
  const race = bubble("s-race").getByRole("button", { name: /^Interrupt and steer now:/ })
  fixture.holdDeliver = true
  await race.click()
  const won = fixture.receipts.find((item) => item.requestID === "s-race")
  const info = { id: "msg_natural_race", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: Date.now() } }
  fixture.messages.push({ info, parts: [{ id: "prt_natural_race", sessionID: "ses_a", messageID: info.id, type: "text", text: won.text }] })
  Object.assign(won, { state: "promoted", messageID: info.id, timePromoted: Date.now() })
  fixture.emit("message.updated", { info })
  fixture.emit("message.part.updated", { part: fixture.messages.at(-1).parts[0] })
  fixture.holdDeliver = false
  fixture.deliverReplies.splice(0).forEach((reply) => reply())
  await expect(bubble("s-race")).toHaveCount(0)
  await expect(users("steer that wins the race")).toHaveCount(1)
  console.info("PASS race with a natural boundary: settled, one message, no duplicate")

  expect(errors).toEqual([])
  expect(fixture.unexpected).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}
