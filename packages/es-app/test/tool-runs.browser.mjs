import { createRequire } from "node:module"
import { startToolRunsPreview } from "./tool-runs-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startToolRunsPreview(0, { filler: 45 })
const fixture = preview.fixture
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
const unexpectedWrites = () => fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method) &&
  !(call.method === "POST" && call.path === "/api/attention/session" && JSON.stringify(call.body) === "{}"))
const reads = () => fixture.calls.filter((call) => call.path === "/session/ses_a/message").length
const shot = async (page, name) => { if (process.env.TOOL_RUN_SHOTS) await page.screenshot({ path: `${process.env.TOOL_RUN_SHOTS}-${name}.png` }) }

const run = async (viewport, label) => {
  const context = await browser.newContext({ viewport })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`))
  const transcript = page.locator(".session-page .transcript")
  const editor = () => page.getByRole("textbox", { name: "Message", exact: true })
  // Tool chips carry their part ID; read/search chips are one-item context groups.
  const chip = (id) => page.locator([`[data-timeline-part-id="${id}"]`, `[data-activity-group][data-timeline-part-ids="${id}"]`,
    `[data-activity-group][data-timeline-part-ids^="${id},"]`, `[data-activity-group][data-timeline-part-ids$=",${id}"]`,
    `[data-activity-group][data-timeline-part-ids*=",${id},"]`].map((selector) => `.transcript ${selector}`).join(", "))
  const runFor = (id) => page.locator(`.tool-run[data-timeline-part-ids*="${id}"]`).first()
  // The newest turn is still streaming; earlier finished turns coalesce meanwhile.
  fixture.status = "busy"
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  await expect(page.locator('[data-find-message="msg_1011"]')).toBeVisible({ timeout: 30_000 })
  const emitPart = (messageID, part) => fixture.emit("message.part.updated", { part: { ...part, messageID, sessionID: "ses_a" } })
  const emitMessage = (message) => {
    fixture.emit("message.updated", { info: message.info })
    message.parts.forEach((part) => fixture.emit("message.part.updated", { part }))
  }

  // Every adjacent block of finished calls in a finished turn is one run, whatever its tools, sizes or outcomes.
  await expect(page.locator(".tool-run")).toHaveCount(3)
  const first = runFor("p11_read")
  await expect(first).toHaveAttribute("data-timeline-part-ids", "p11_read,p12_grep,p13_glob,p14_bash")
  await expect(first.locator(".tool-run-summary")).toHaveAttribute("aria-expanded", "false")
  await expect(first.locator(".tool-run-kind")).toHaveText("4 tool calls")
  await expect(first.locator(".tool-run-tools")).toHaveText("read · grep · glob · bash")
  await expect(first.locator(".tool-run-span")).toHaveText("200ms")
  await expect(first.locator(".tool-run-notes")).toHaveCount(0)
  await expect(first.locator(".tool-size")).toHaveCount(0)
  const second = runFor("p21_big")
  await expect(second).toHaveAttribute("data-timeline-part-ids", "p21_big,p22_fail,p23_a,p24_b")
  await expect(second.locator(".tool-run-tools")).toHaveText("read ×3 · bash")
  await expect(second.locator(".tool-run-notes")).toHaveText("1 failed")
  // Wall clock from first start to last end, not a sum.
  await expect(second.locator(".tool-run-span")).toHaveText("2.0s")
  await expect(second.locator(".tool-run-summary")).toHaveAttribute("aria-label", "4 tool calls, read ×3 · bash, 2.0s wall clock, 1 failed")
  // A shell call that reported a nonzero exit is counted, not split out.
  const third = runFor("p40_ta")
  await expect(third).toHaveAttribute("data-timeline-part-ids", "p40_ta,p41_tb,p42_tc,p43_fail,p44_sa,p45_sb,p46_sc")
  await expect(third.locator(".tool-run-tools")).toHaveText("read · grep · glob · bash ×4")
  await expect(third.locator(".tool-run-notes")).toHaveText("1 failed")
  for (const id of ["p11_read", "p12_grep", "p13_glob", "p14_bash", "p21_big", "p22_fail", "p43_fail"]) await expect(chip(id)).toHaveCount(0)
  // The live turn keeps every call visible, finished or not, and has no footer yet.
  for (const id of ["p61_la", "p62_lb", "p63_lc"]) await expect(chip(id)).toHaveCount(1)
  await expect(chip("p63_lc").locator(".tool-size")).toHaveAttribute("data-size", "running")
  await expect(page.locator('[data-find-message="msg_1011"] .turn-summary')).toHaveCount(0)
  await expect(page.locator('[data-find-message="msg_1003"] .turn-summary')).toHaveCount(1)
  // The run renders where its first member was: after the prose that preceded it, before the next message.
  const order = await page.evaluate(() => [...document.querySelectorAll(".transcript [data-find-message='msg_1001'] :is([data-component='text-part'], .tool-run), .transcript [data-find-message='msg_1003'] [data-component='text-part']")]
    .map((element) => element.matches(".tool-run") ? "run" : element.textContent.trim().slice(0, 12)))
  expect(order).toEqual(["Looking at t", "run", "Found the se"])

  // Expansion shows the original chips with their IDs and per-call size badges.
  await first.locator(".tool-run-summary").click()
  await expect(first.locator(".tool-run-summary")).toHaveAttribute("aria-expanded", "true")
  for (const id of ["p11_read", "p12_grep", "p13_glob", "p14_bash"]) {
    await expect(chip(id)).toHaveCount(1)
    await expect(first.locator(`[data-tool-run-member="${id}"]`)).toHaveAttribute("data-call-id", `call_${id}`)
  }
  await expect(first.locator('[data-tool-run-member="p14_bash"]')).toHaveAttribute("data-message-id", "msg_1002")
  await expect(chip("p14_bash").locator(".tool-size")).toHaveAttribute("data-size", "XS")
  await second.locator(".tool-run-summary").focus()
  await page.keyboard.press("Enter")
  await expect(second.locator(".tool-run-summary")).toHaveAttribute("aria-expanded", "true")
  await expect(chip("p21_big").locator(".tool-size")).toHaveAttribute("aria-label", /^Size L: ~12k characters \(input 20, output 12k\)/)
  await expect(chip("p22_fail")).toHaveCount(1)
  await page.keyboard.press("Space")
  await expect(second.locator(".tool-run-summary")).toHaveAttribute("aria-expanded", "false")

  // Desktop: the reader opens a live call; mobile: the reader leaves the live turn alone.
  const engaged = label === "desktop"
  if (engaged) {
    await chip("p61_la").locator('[data-slot="collapsible-trigger"]').first().click()
  }
  // Streaming: the running call finishes and a provider step ends with tool calls. Still a live turn.
  emitPart("msg_1011", preview.tool("p63_lc", "bash", { command: "sleep 1" }, "done", { metadata: { exit: 0 }, end: 900 }))
  const step = preview.assistant("msg_1012", "msg_1010", [
    preview.tool("p70_ma", "read", { filePath: "/workspace/m-a" }, "m a"),
    preview.tool("p71_mb", "edit", { filePath: "/workspace/m-b" }, "edited", { end: 1_400 }),
  ], { info: { finish: "tool-calls" } })
  const liveInfo = fixture.messages.find((message) => message.info.id === "msg_1011").info
  fixture.emit("message.updated", { info: { ...liveInfo, finish: "tool-calls", time: { ...liveInfo.time, completed: liveInfo.time.created + 1 } } })
  emitMessage(step)
  await expect(chip("p71_mb")).toHaveCount(1)
  for (const id of ["p61_la", "p62_lb", "p63_lc", "p70_ma", "p71_mb"]) await expect(chip(id)).toHaveCount(1)
  await expect(page.locator(".tool-run")).toHaveCount(3)
  await expect(page.locator('[data-find-message="msg_1012"] .turn-summary')).toHaveCount(0)
  // The final step completes the turn: its adjacent calls coalesce across both steps and the footer appears.
  emitMessage(preview.assistant("msg_1013", "msg_1010", [preview.text("p80_done", "All checks pass.")], { info: { finish: "stop" } }))
  const tail = runFor("p61_la")
  await expect(tail).toHaveAttribute("data-timeline-part-ids", "p61_la,p62_lb,p63_lc,p70_ma,p71_mb")
  await expect(tail.locator(".tool-run-tools")).toHaveText("read ×3 · bash · edit")
  await expect(tail.locator(".tool-run-span")).toHaveText("1.4s")
  await expect(page.locator('[data-find-message="msg_1013"] .turn-summary')).toHaveCount(1)
  // A call the reader opened while live keeps its run open; otherwise the run collapses.
  await expect(tail.locator(".tool-run-summary")).toHaveAttribute("aria-expanded", engaged ? "true" : "false")
  for (const id of ["p61_la", "p62_lb", "p63_lc", "p70_ma", "p71_mb"]) await expect(chip(id)).toHaveCount(engaged ? 1 : 0)
  await shot(page, `${label}-completed`)
  if (engaged) await tail.locator(".tool-run-summary").click()
  await first.locator(".tool-run-summary").click()
  await expect(first.locator(".tool-run-summary")).toHaveAttribute("aria-expanded", "false")
  await expect(tail.locator(".tool-run-summary")).toHaveAttribute("aria-expanded", "false")

  // RTL: the disclosure follows direction; tool names stay isolated LTR.
  for (const dir of ["ltr", "rtl"]) {
    await page.evaluate((value) => { document.documentElement.dir = value }, dir)
    const geometry = await first.locator(".tool-run-summary").evaluate((element) => {
      const box = element.getBoundingClientRect()
      const disclosure = element.querySelector(".tool-run-disclosure").getBoundingClientRect()
      return { start: disclosure.left - box.left, end: box.right - disclosure.right, overflow: element.scrollWidth - element.clientWidth }
    })
    if (dir === "ltr") expect(geometry.start).toBeLessThan(geometry.end)
    else expect(geometry.end).toBeLessThan(geometry.start)
    expect(geometry.overflow).toBeLessThanOrEqual(0)
    expect(await page.locator(".tool-run-tools").first().evaluate((element) => getComputedStyle(element).direction)).toBe("ltr")
    await shot(page, `${label}-${dir}`)
  }
  await page.evaluate(() => { document.documentElement.dir = "rtl"; document.documentElement.lang = "ar" })
  await expect(first.locator(".tool-run-summary")).toBeVisible()
  await page.evaluate(() => { document.documentElement.dir = "ltr"; document.documentElement.lang = "en" })

  // Prompt navigation: only real prompts; mail and generated inputs are skipped.
  const prompts = await page.locator("[data-user-prompt]").evaluateAll((elements) => elements.map((element) => element.dataset.userPrompt))
  expect(prompts.slice(-3)).toEqual(["msg_1000", "msg_1006", "msg_1010"])
  expect(prompts).not.toContain("msg_1004")
  expect(prompts).not.toContain("msg_1008")
  await expect(page.locator("#prompt-msg_1006")).toHaveAttribute("data-user-prompt", "msg_1006")
  await editor().fill("Draft stays put שלום")
  await editor().evaluate((element) => { element.focus(); element.setSelectionRange(3, 9, "backward") })
  const draft = await editor().evaluate((element) => [element.value, element.selectionStart, element.selectionEnd, element.selectionDirection])
  const writes = unexpectedWrites().length
  const pageReads = reads()
  const previous = page.getByRole("button", { name: "Previous prompt", exact: true })
  const next = page.getByRole("button", { name: "Next prompt", exact: true })
  await page.keyboard.press("Control+f")
  await page.getByRole("searchbox", { name: "Find in transcript" }).fill("needle-in-grep")
  await expect(page.locator(".find-result")).toHaveCount(1)
  await editor().focus()
  await editor().evaluate((element) => element.setSelectionRange(3, 9, "backward"))
  // Pin to the bottom, then walk up through the loaded prompts.
  await transcript.evaluate((element) => { element.scrollTop = element.scrollHeight })
  const startAt = await page.evaluate(() => {
    const container = document.querySelector(".session-page .transcript").getBoundingClientRect().top
    return [...document.querySelectorAll("[data-user-prompt]")].findLastIndex((element) => element.getBoundingClientRect().top - container < -30)
  })
  const seen = []
  for (let step = 0; step < 3; step++) {
    await previous.click()
    await expect(editor()).toBeFocused()
    seen.push(await page.evaluate(() => {
      const container = document.querySelector(".session-page .transcript").getBoundingClientRect().top
      return [...document.querySelectorAll("[data-user-prompt]")].find((element) => Math.abs(element.getBoundingClientRect().top - container - 8) < 2)?.dataset.userPrompt
    }))
  }
  expect(seen).toEqual([prompts[startAt], prompts[startAt - 1], prompts[startAt - 2]])
  await next.click()
  expect(await page.evaluate(() => {
    const container = document.querySelector(".session-page .transcript").getBoundingClientRect().top
    return [...document.querySelectorAll("[data-user-prompt]")].find((element) => Math.abs(element.getBoundingClientRect().top - container - 8) < 2)?.dataset.userPrompt
  })).toBe(prompts[startAt - 1])
  // Manual scroll is respected: next is relative to where the reader is now.
  const manual = await transcript.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }))
    element.scrollTop = Math.round(element.scrollHeight / 3)
    return element.scrollTop
  })
  await expect(previous).toHaveAccessibleDescription(/^prompt \d+ of \d+ · loaded history only/)
  const expected = await page.evaluate(() => {
    const container = document.querySelector(".session-page .transcript").getBoundingClientRect().top
    return [...document.querySelectorAll("[data-user-prompt]")].find((element) => element.getBoundingClientRect().top - container > 30)?.dataset.userPrompt
  })
  await next.click()
  expect(await transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(manual)
  expect(await page.evaluate(() => {
    const container = document.querySelector(".session-page .transcript").getBoundingClientRect().top
    return [...document.querySelectorAll("[data-user-prompt]")].find((element) => Math.abs(element.getBoundingClientRect().top - container - 8) < 2)?.dataset.userPrompt
  })).toBe(expected)
  // At the first loaded prompt, Previous shows the explicit loader and fetches nothing.
  for (let step = 0; step < 80 && await transcript.evaluate((element) => element.scrollTop > 0); step++) await previous.click()
  await expect(page.locator(".transcript-older")).toBeInViewport()
  expect(reads()).toBe(pageReads)
  expect(await editor().evaluate((element) => [element.value, element.selectionStart, element.selectionEnd, element.selectionDirection])).toEqual(draft)
  await expect(page.locator(".find-result")).toHaveCount(1)
  expect(unexpectedWrites().length).toBe(writes)

  // Keyboard: Ctrl+N from the transcript moves to the next prompt.
  await transcript.evaluate((element) => { element.scrollTop = 0 })
  await page.locator(".session-page .transcript").click({ position: { x: 5, y: 5 } })
  const before = await transcript.evaluate((element) => element.scrollTop)
  await page.keyboard.press("Control+n")
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(before)

  // Find reveals a match hidden inside a collapsed run and marks the member.
  await expect(first.locator(".tool-run-summary")).toHaveAttribute("aria-expanded", "false")
  await page.locator(".find-result").first().click()
  await expect(first.locator(".tool-run-summary")).toHaveAttribute("aria-expanded", "true")
  await expect(first.locator('[data-tool-run-member="p12_grep"]')).toHaveAttribute("data-find-selected", "true")
  await expect(first.locator('[data-tool-run-member="p12_grep"] .find-jump')).toContainText("needle-in-grep")
  await expect(first.locator('[data-tool-run-member="p12_grep"]')).toBeInViewport()
  await expect(page.locator('[data-find-message="msg_1001"] > .find-jump')).toHaveCount(0)
  await shot(page, `${label}-find`)
  expect(unexpectedWrites().length).toBe(writes)
  await context.close()
  fixture.status = "idle"
}

// Prepending an earlier page regroups runs (new keys); the user's expansion follows its members.
const pagination = async () => {
  const paged = await startToolRunsPreview(0)
  const read = (id) => paged.tool(id, "read", { filePath: `/workspace/${id}` }, id)
  paged.fixture.messages = [
    { info: { id: "msg_a0000", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: 1 } },
      parts: [{ id: "msg_a0000_text", messageID: "msg_a0000", sessionID: "ses_a", type: "text", text: "Read everything." }] },
    ...Array.from({ length: 90 }, (_, index) => {
      const id = `msg_a${String(index + 1).padStart(4, "0")}`
      return paged.assistant(id, "msg_a0000", [read(`prt_${id}`)])
    }),
  ]
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === paged.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(`pagination: ${error.message}`))
  try {
    await page.goto(paged.url, { waitUntil: "domcontentloaded" })
    const runs = page.locator(".tool-run")
    await expect(runs).toHaveCount(1, { timeout: 30_000 })
    const only = runs.first()
    await expect(only).toHaveAttribute("data-timeline-part-ids", /^prt_msg_a0011,.*,prt_msg_a0090$/)
    await only.locator(".tool-run-summary").click()
    await expect(only.locator("[data-tool-run-member]")).toHaveCount(80)
    const writes = unexpectedWrites().length
    await page.getByRole("button", { name: "Load earlier messages" }).click()
    // The prepended calls join the same run (new key) without a size split, and it stays open.
    await expect(page.locator(".tool-run [data-tool-run-member]")).toHaveCount(90)
    const ids = await runs.evaluateAll((elements) => elements.map((element) => [element.dataset.timelinePartIds.split(","), element.dataset.open === "true"]))
    expect(ids.map(([members]) => members.length)).toEqual([90])
    expect(ids.flatMap(([members]) => members)).toEqual(Array.from({ length: 90 }, (_, index) => `prt_msg_a${String(index + 1).padStart(4, "0")}`))
    expect(ids.map(([, open]) => open)).toEqual([true])
    await expect(runs.first().locator(".tool-run-kind")).toHaveText("90 tool calls")
    expect(unexpectedWrites().length).toBe(writes)
  } finally {
    await context.close()
    await paged.close()
  }
}

try {
  await run({ width: 1440, height: 1000 }, "desktop")
  await run({ width: 390, height: 844 }, "mobile")
  await pagination()
  expect(errors).toEqual([])
  console.log("tool runs browser checks passed")
} finally {
  await browser.close()
  await preview.close()
}
