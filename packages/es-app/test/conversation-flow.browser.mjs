// Conversation flow review (dotfiles#240, ux-feel#83/#85): drives the session
// composer through slow send, lost ACK, busy steer/queue, 502 and offline with
// text + images, and records composer/transcript geometry at every step.
// FLOW_SHOTS=<dir> writes a screenshot per step. FLOW_REPORT=1 prints the
// geometry table and skips the stability assertions (used for "before" runs).
import { createRequire } from "node:module"
import { mkdir, writeFile } from "node:fs/promises"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { imageCapability } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
fixture.images = imageCapability
fixture.messages = [
  ...fixture.messages,
  ...Array.from({ length: 16 }, (_, index) => ({
    info: { id: `msg_f${String(index).padStart(2, "0")}`, sessionID: "ses_a", role: index % 2 ? "assistant" : "user", agent: "build", mode: "build",
      providerID: "fixture", modelID: "test", model: { providerID: "fixture", modelID: "test" }, time: { created: 10 + index },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [{ id: `part_f${index}`, sessionID: "ses_a", messageID: `msg_f${String(index).padStart(2, "0")}`, type: "text",
      text: index % 2 ? `Reply ${index}: checked the parser and the fixture; next I will run the suite.` : `Question ${index}: what changed in the parser?` }],
  })),
]
const report = !!process.env.FLOW_REPORT
const shots = process.env.FLOW_SHOTS
if (shots) await mkdir(shots, { recursive: true })
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const editor = page.getByRole("textbox", { name: "Message", exact: true })
const rows = []

const measure = async (step) => {
  const geometry = await page.evaluate(() => {
    const rect = (selector) => {
      const el = document.querySelector(selector)
      if (!el) return undefined
      const box = el.getBoundingClientRect()
      return box.height ? { top: Math.round(box.top), height: Math.round(box.height) } : undefined
    }
    const transcript = document.querySelector(".transcript")
    const visible = (el) => !!el.getBoundingClientRect().height
    const text = (selector) => [...document.querySelectorAll(selector)].filter(visible).map((el) => el.textContent.replace(/\s+/g, " ").trim()).filter(Boolean)
    return {
      composer: rect(".prompt-box:not([inert])"),
      textarea: rect(".prompt-box:not([inert]) textarea"),
      results: rect(".composer-results"),
      transcriptHeight: transcript ? Math.round(transcript.clientHeight) : undefined,
      fromBottom: transcript ? Math.round(transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight) : undefined,
      draftImages: document.querySelectorAll('.prompt-box:not([inert]) button[aria-label^="Remove "]').length,
      boxes: [...document.querySelectorAll(".composer-results > *, .outgoing-msg, .direct-status, .session-alerts > *, .banner")].filter(visible).length,
      status: [
        ...text(".pending-hint"),
        ...text(".composer-results > section b, .composer-results > details > summary"),
        ...text(".direct-status"),
        ...text(".session-work-status"),
        ...text(".session-alerts > *"),
      ],
    }
  })
  rows.push({ step, ...geometry })
  if (shots) await page.screenshot({ path: `${shots}/${String(rows.length).padStart(2, "0")}-${step}.png` })
  return geometry
}

const paste = async () => {
  const source = await browser.newPage()
  await source.setContent('<div style="width:64px;height:40px;background:#3a6ea5;color:#fff;font:12px sans-serif">shot</div>')
  const image = (await source.locator("div").screenshot()).toString("base64")
  await source.close()
  await editor.evaluate((el, image) => {
    const data = new DataTransfer()
    data.items.add(new File([Uint8Array.from(atob(image), (char) => char.charCodeAt(0))], "shot.png", { type: "image/png" }))
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }))
  }, image)
  await expect(page.locator('.prompt-box button[aria-label^="Remove "]')).toHaveCount(1)
}

const echo = (id, text) => {
  const info = { id, sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: Date.now() } }
  fixture.emit("message.updated", { info })
  fixture.emit("message.part.updated", { part: { id: `part_${id}`, sessionID: "ses_a", messageID: id, type: "text", text } })
}

const send = async () => {
  await editor.press("Meta+Enter")
}

try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 120000 })
  await expect(page.locator('[data-component="user-message"]').first()).toBeVisible()
  await expect(page.locator('.prompt-box button[aria-label="Send"]')).toBeVisible()
  await page.waitForTimeout(500)
  await measure("idle-empty")

  // 1. Slow plain send with an image: held for the whole "10s" window, then accepted, then echoed.
  fixture.holdNormal = true
  await editor.fill("Please check the parser change in this screenshot")
  await paste()
  await measure("idle-draft-image")
  await send()
  await page.waitForTimeout(150)
  await measure("send-sending")
  if (!report) await expect(page.locator('.outgoing-msg[data-status="sending"] img')).toHaveCount(1)
  await page.waitForTimeout(2500)
  await measure("send-slow-2s")
  fixture.normalReplies.shift()()
  await page.waitForTimeout(300)
  await measure("send-accepted-no-echo")
  echo("msg_zz1", "Please check the parser change in this screenshot")
  await page.waitForTimeout(300)
  await measure("send-echoed")
  fixture.holdNormal = false

  // 2. Lost acknowledgement on a plain send.
  fixture.loseNormal = true
  await editor.fill("Also run the suite")
  await send()
  await page.waitForTimeout(400)
  await measure("send-lost-ack")
  const edit = page.locator(".outgoing-msg").getByRole("button", { name: "Edit" })
  if (await edit.count()) {
    await edit.click()
    await expect(editor, "Edit puts the unconfirmed message back").toHaveValue("Also run the suite")
    await expect(page.locator('.outgoing-msg[data-status="unknown"]')).toHaveCount(0)
  } else {
    const dismiss = page.getByRole("button", { name: "Dismiss" })
    if (await dismiss.count()) await dismiss.first().click()
  }
  await page.waitForTimeout(200)
  await measure("send-lost-resolved")
  await editor.fill("")

  // 3. Busy agent: steer held (admission in flight), then accepted into Pending inputs.
  fixture.setStatus("busy")
  await page.waitForTimeout(400)
  await measure("busy-idle-composer")
  fixture.holdInput = true
  await editor.fill("Prefer bun APIs for the file reads")
  await paste()
  await page.getByRole("button", { name: /^Queue|^Steer/ }).first().waitFor()
  await send()
  await page.waitForTimeout(200)
  await measure("busy-steer-confirming")
  await page.waitForTimeout(2500)
  await measure("busy-steer-slow-2s")
  fixture.inputReplies.shift()?.()
  await page.waitForTimeout(400)
  await measure("busy-steer-pending")
  fixture.holdInput = false

  // 4. Busy agent: lost ACK on queue -> admission unknown.
  fixture.acceptedAckLost = true
  await editor.fill("After this, summarise failures")
  await editor.press("Meta+m")
  await send()
  await page.waitForTimeout(500)
  await measure("busy-queue-lost-ack")
  const check = page.getByRole("button", { name: /^Check( admission)?$/ })
  if (await check.count()) await check.first().click()
  await page.waitForTimeout(500)
  await measure("busy-queue-reconciled")

  // 5. Daemon 502 on admission (HTML error body).
  const admission = (url) => url.pathname.endsWith("/session/ses_a/input")
  await page.route(admission, (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 502, contentType: "text/html", body: "<html><body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>" })
    : route.continue())
  await editor.fill("One more steer")
  await send()
  await page.waitForTimeout(500)
  await measure("busy-502")
  if (!report) {
    const cue = page.locator('.outgoing-msg[data-status="unknown"] .pending-hint')
    // The readback by request ID finds no such input, so the cue says so (one Retry), not "Not confirmed".
    await expect(cue).toContainText("Not sent")
    expect(await cue.getAttribute("title"), "diagnostics stay out of the HTML error page").not.toContain("<")
  }
  await page.unroute(admission)

  // 6. Offline: event stream drops and stays down past the 2s status delay.
  await page.route("**/oc/**/event**", (route) => route.abort())
  await page.route("**/oc/event**", (route) => route.abort())
  fixture.disconnect()
  await page.waitForTimeout(3000)
  await measure("offline")
  await page.unroute("**/oc/**/event**")
  await page.unroute("**/oc/event**")
  await page.waitForTimeout(4000)
  await measure("recovered")

  console.log(JSON.stringify(rows.map((row) => ({ step: row.step, composerTop: row.composer?.top, composerH: row.composer?.height, textareaH: row.textarea?.height,
    resultsH: row.results?.height ?? 0, transcriptH: row.transcriptHeight, fromBottom: row.fromBottom, boxes: row.boxes, status: row.status.join(" | ") })), null, 1))
  if (shots) await writeFile(`${shots}/geometry.json`, JSON.stringify(rows, null, 1))
  if (!report) {
    // Images attached in the editor grow the draft itself; delivery states must not.
    const stable = rows.filter((row) => !row.draftImages)
    const tops = new Set(stable.map((row) => row.composer?.top))
    expect([...tops], "composer top must not move across send states").toHaveLength(1)
    expect(new Set(stable.map((row) => row.transcriptHeight)).size, "transcript height must not change").toBe(1)
    for (const row of stable) expect(row.fromBottom, `${row.step}: transcript stays pinned to the newest message`).toBeLessThan(4)
  }
  expect(errors).toEqual([])
  console.log("PASS conversation flow")
} finally {
  await browser.close()
  await preview.close()
}
