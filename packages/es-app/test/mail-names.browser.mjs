import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { session } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const directory = `${fixture.editspaces[0].root}/lanes/squadron-v2/repos/org/repo`
const at = Date.parse("2026-10-20T12:00:00Z")
const long = "Joiner — batch orchestrator coordinating every ready issue across all lanes this week"
fixture.sessionIDs = ["ses_a", "ses_relay", "ses_joiner"]
fixture.sessionTitles.set("ses_a", "Tether").set("ses_relay", "Relay").set("ses_joiner", long)
fixture.sessionTimes.set("ses_a", { created: at, updated: at + 60_000 })
fixture.workspaceSessions = [{ ...session("ses_relay_old"), title: "Relay before handoff", time: { created: 1, updated: 2 } },
  { ...session("ses_impostor"), title: "Not Relay", time: { created: 1, updated: 2 } }]
fixture.laneOwners = [{ lane: "squadron-v2", owner: "ses_a" }, { lane: "orchestrator", owner: "ses_relay" }, { lane: "batch-orchestrator", owner: "ses_joiner" }]
fixture.handoffs = [{ lane: "orchestrator", predecessor: "ses_relay_old", successor: "ses_relay" }]
const delivery = (message_id, recipient, sessionID) => ({ message_id, recipient, session: sessionID, mode: "actionable", state: "handled", request_id: null, error: null })
const mail = (id, offset, from, to, direction, extra = {}) => ({ id, ts: new Date(at + offset).toISOString(), created_ms: at + offset, from, to, direction,
  kind: "task", text: `Body of ${id}`, deliveries: [], ...extra })
const records = [
  mail("from-predecessor", 1000, "orchestrator", "squadron-v2", "received", { sender_session: "ses_relay_old", deliveries: [delivery("from-predecessor", "squadron-v2", "ses_a")] }),
  mail("legacy", 2000, "orchestrator", "squadron-v2", "received"),
  mail("impostor", 3000, "orchestrator", "squadron-v2", "received", { sender_session: "ses_impostor" }),
  mail("unknown-lane", 4000, "ghost-lane", "squadron-v2", "received", { sender_session: "ses_ghost" }),
  mail("to-relay", 5000, "squadron-v2", "orchestrator", "sent", { sender_session: "ses_a", deliveries: [delivery("to-relay", "orchestrator", "ses_relay")] }),
  mail("to-joiner", 6000, "squadron-v2", "batch-orchestrator", "sent", { sender_session: "ses_a", deliveries: [delivery("to-joiner", "batch-orchestrator", "ses_joiner")] }),
  mail("promoted", 7000, "orchestrator", "squadron-v2", "received", { sender_session: "ses_relay", deliveries: [delivery("promoted", "squadron-v2", "ses_a")] }),
]
fixture.mail = (es, recipient) => ({ editspace: es, lane: recipient === "squadron-v2" ? recipient : "", messages: records })
const base = { sessionID: "ses_a", agent: "build", model: { providerID: "fixture", modelID: "test" } }
fixture.messages = [
  { info: { ...base, id: "msg_001", role: "user", time: { created: at + 500 } },
    parts: [{ id: "prt_001", messageID: "msg_001", sessionID: "ses_a", type: "text", text: "Human prompt" }] },
  { info: { ...base, id: "msg_002", role: "user", time: { created: at + 8000 },
    source: { type: "editspace-mail", id: "promoted", sender: "orchestrator", recipient: "squadron-v2", kind: "task" } },
    parts: [{ id: "prt_002", messageID: "msg_002", sessionID: "ses_a", type: "text", text: "Promoted mail body" }] },
  { info: { id: "msg_003", sessionID: "ses_a", role: "assistant", parentID: "msg_002", agent: "build", mode: "build", providerID: "fixture", modelID: "test",
    path: { cwd: directory, root: directory }, cost: 0, finish: "stop", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: at + 8100, completed: at + 8200 } },
    parts: [{ id: "prt_003", messageID: "msg_003", sessionID: "ses_a", type: "text", text: "Done." }] },
  { info: { ...base, id: "msg_004", role: "user", time: { created: at + 9000 },
    source: { type: "editspace-mail", id: "es-resume-1", sender: "batch-orchestrator", senderSession: "ses_joiner", recipient: "squadron-v2", kind: "resume" } },
    parts: [{ id: "prt_004", messageID: "msg_004", sessionID: "ses_a", type: "text", text: "Joiner finished the report" }] },
]
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const errors = []
const route = (page, id) => page.locator(`.transcript [data-mail-id="${id}"] .mail-activity-route`)
const parties = (locator) => locator.locator(".mail-party")
try {
  for (const rtl of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 900, height: 900 } })
    if (rtl) await context.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { document.documentElement.dir = "rtl" }))
    const page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)

    // Inbound: verified continuity names the sender; legacy, impostor and unknown lanes keep the address.
    await expect(parties(route(page, "from-predecessor"))).toHaveText(["Relay", "Tether"])
    await expect(parties(route(page, "from-predecessor")).first()).toHaveAttribute("title", "Lane orchestrator · session ses_relay_old → ses_relay")
    await expect(parties(route(page, "legacy"))).toHaveText(["orchestrator", "squadron-v2"])
    await expect(parties(route(page, "legacy")).first()).toHaveAttribute("title", "Lane orchestrator")
    await expect(parties(route(page, "impostor"))).toHaveText(["orchestrator", "squadron-v2"])
    await expect(parties(route(page, "unknown-lane"))).toHaveText(["ghost-lane", "squadron-v2"])

    // Outbound: the recipient is named by the session that received it.
    await expect(parties(route(page, "to-relay"))).toHaveText(["Tether", "Relay"])
    await expect(parties(route(page, "to-joiner"))).toHaveText(["Tether", long])

    // A long name truncates on its own; the other party stays visible.
    const box = await route(page, "to-joiner").boundingBox()
    const sender = await parties(route(page, "to-joiner")).first().boundingBox()
    const recipient = await parties(route(page, "to-joiner")).last().boundingBox()
    if (!box || !sender || !recipient) throw new Error("mail route not laid out")
    for (const item of [sender, recipient])
      if (item.x < box.x - 1 || item.x + item.width > box.x + box.width + 1) throw new Error(`party overflows its route (rtl=${rtl})`)
    if (rtl && !(sender.x > recipient.x)) throw new Error("RTL route does not read right to left")

    // Transcript mail input, agent resume and the turn-input note.
    const promoted = page.locator('[data-mail-message-id="msg_002"] .mail-activity-route .mail-party')
    await expect(promoted).toHaveText(["Relay", "Tether"])
    await expect(page.locator('[data-mail-message-id="msg_004"] .mail-activity-route .mail-party')).toHaveText([long, "Tether"])
    await expect(page.locator(".mail-cause .mail-party")).toHaveText(["Relay"])

    // Expanded details keep the lane address beside the name.
    await route(page, "to-relay").click()
    await expect(page.locator('.transcript [data-mail-id="to-relay"] .mail-activity-details')).toContainText("To: Relay · lane orchestrator")

    // Lane mail panel rows use the same names.
    await page.getByRole("button", { name: "Session mail" }).click()
    await page.getByRole("menuitem", { name: /Lane mail/ }).click()
    await expect(page.locator('.lane-mail [data-mail-id="to-relay"] .mail-activity-route .mail-party')).toHaveText(["Tether", "Relay"])

    if (!rtl) {
      // A rename shows the current title; the lane address is unchanged.
      fixture.sessionTitles.set("ses_relay", "Relay Prime")
      const info = { ...session("ses_relay"), title: "Relay Prime", time: { created: 1, updated: Date.now() } }
      for (const [response, stream] of fixture.eventStreams) if (stream.path === "/global/event")
        response.write(`data: ${JSON.stringify({ directory: info.directory, payload: { type: "session.updated", properties: { sessionID: "ses_relay", info } } })}\n\n`)
      await expect(parties(route(page, "to-relay")).last()).toHaveText("Relay Prime", { timeout: 15000 })
      await expect(parties(route(page, "to-relay")).last()).toHaveAttribute("data-lane", "orchestrator")
      fixture.sessionTitles.set("ses_relay", "Relay")
    }
    await context.close()
  }
  expect(errors).toEqual([])
  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log("PASS mail names: inbound/outbound rows, transcript input, agent resume, turn-input note, lane mail panel; handoff continuity, legacy/impostor/unknown fallback, rename, overflow, RTL; no writes")
} finally {
  await browser.close()
  await preview.close()
}
