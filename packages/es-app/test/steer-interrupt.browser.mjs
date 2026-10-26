// A steer sent while a long tool runs says what it waits on and offers "Interrupt & deliver": one request
// stops the tool (its partial output stays, marked interrupted) and starts the next turn with the steer.
// No Stop, no resend, no second prompt; the draft and other pending inputs are untouched. A steer left
// pending after Stop offers "Deliver now". Without the server capability, only the reason is shown.
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
  const deliver = bubble(id).getByRole("button", { name: /^Interrupt and deliver steer:/ })
  await expect(deliver).toHaveText("Interrupt & deliver")
  await expect(deliver).toHaveAttribute("title", /Stops bash \(its output so far is kept\).*Nothing is rerun/)
  await expect(bubble("q-later").locator(".outgoing-cue > span")).toHaveText("Queued · after this task")
  await expect(bubble("q-later").getByRole("button", { name: /deliver/i })).toHaveCount(0)
  await shot("1-waiting")
  console.info("PASS steer during a long tool: cue names the running tool and its age; Interrupt & deliver offered on the steer only")

  // 2. Interrupt & deliver: one request; the tool stops with its partial output, the steer starts the next turn.
  await editor.fill("unrelated draft in progress")
  fixture.holdDeliver = true
  await deliver.click()
  await expect(deliver).toHaveText("Delivering…")
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
  console.info("PASS Interrupt & deliver: one deliver request, no abort/prompt/resend; tool interrupted with partial output; steer is the next user message; draft and queued input kept")

  // 3. A steer left pending after Stop is delivered with one click, not retyped.
  await page.getByRole("button", { name: "Stop session", exact: true }).click()
  await expect(page.locator(".session-work-status:visible")).toHaveAttribute("data-state", "idle")
  fixture.receipts.push({ requestID: "s-stranded", sessionID: "ses_a", delivery: "steer", text: "then run only the es-app tests",
    agent: "build", admittedSeq: 3, timeCreated: Date.now(), state: "pending" })
  fixture.emit("session.input.updated", { sessionID: "ses_a" })
  await expect(bubble("s-stranded").locator(".outgoing-cue > span")).toHaveText("Steer · not delivered; the session stopped")
  const now = bubble("s-stranded").getByRole("button", { name: /^Deliver steer:/ })
  await expect(now).toHaveText("Deliver now")
  await now.click()
  await expect(bubble("s-stranded")).toHaveCount(0)
  await expect(page.locator('[data-component="user-message"]').last()).toContainText("then run only the es-app tests")
  expect(steerPosts()).toHaveLength(1)
  expect(forbidden().filter((call) => call.path.endsWith("/prompt_async"))).toEqual([])
  console.info("PASS steer stranded by Stop: Deliver now starts a turn with it under its own request ID; nothing retyped")

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
  await expect(bubble("s-old").getByRole("button", { name: /deliver/i })).toHaveCount(0)
  console.info("PASS without server support: waiting reason only, no deliver action")

  expect(errors).toEqual([])
  expect(fixture.unexpected).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}
