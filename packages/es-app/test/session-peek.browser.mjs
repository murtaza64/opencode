/* Sidebar hover card + right-panel context (dotfiles#140, #240): the card
 * shows the session's persisted TODOs (in progress first, finished collapsed,
 * observation basis stated) and one token number; the panel shows one token
 * number with no breakdown. Hover gap, Escape, compact rail, RTL side,
 * pinned-row stability, unknowns stay unknown, bounded fetches (never a full
 * transcript for a hovered row), screen-reader description, no polling. */
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const tokens = { input: 3, output: 608, reasoning: 0, cache: { read: 471919, write: 491 } }
fixture.messages[1].info.time.completed = 3
fixture.messages[1].info.tokens = tokens
// a big completed tool output: the open session's bar must attribute it, and
// hovering ses_b (whose transcript is huge) must never fetch it wholesale
fixture.messages[1].parts.push({ id: "tool_big", messageID: "msg_2", sessionID: "ses_a", type: "tool", tool: "bash", callID: "c1",
  state: { status: "completed", input: { command: "cat big.log" }, output: "x".repeat(40000), title: "bash", time: { start: 1, end: 2 } } })
fixture.messagesB = Array.from({ length: 40 }, (_, i) => ({
  info: { id: `b_${i}`, sessionID: "ses_b", role: i % 2 ? "assistant" : "user", agent: "build", providerID: "fixture", modelID: i % 2 ? "mystery" : undefined,
    model: { providerID: "fixture", modelID: "test" }, time: { created: i, ...(i % 2 ? { completed: i + 1 } : {}) },
    ...(i % 2 ? { cost: 0.01, tokens: { input: 1000 + i, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }, path: { cwd: directory, root: directory } } : {}) },
  parts: [{ id: `bp_${i}`, messageID: `b_${i}`, sessionID: "ses_b", type: "text", text: "y".repeat(100000) }],
}))
const insightCalls = () => fixture.calls.filter((c) => c.path === "/api/session-insights")
const messageCalls = (id) => fixture.calls.filter((c) => c.path === `/session/${id}/message`)
fixture.insights = (id) => id === "ses_a"
  ? { session_id: id, directory, cost: 4.2, completed_turns: 12, session_model: { providerID: "fixture", modelID: "test" },
      latest: { model: { providerID: "fixture", modelID: "test-mini" }, cost: 0.1, tokens },
      composition: { unit: "characters", scope: "since_last_compaction", user_text: 60000, assistant_text: 30000, tool_call_metadata: 20000, tool_output: 240000, other_unattributed: 12000 } }
  : { session_id: id, directory, cost: null, completed_turns: 0, session_model: null, latest: null, composition: null }
fixture.todos = new Map([["ses_a", [
  { content: "Read the design", status: "completed", priority: "high" },
  { content: "Wire the peek", status: "in_progress", priority: "high" },
  { content: "Verify in RTL مرحبا", status: "pending", priority: "medium" },
]]])
const todoCalls = (id) => fixture.calls.filter((c) => c.path === `/session/${id}/todo`)
const providers = { providers: [{ id: "fixture", models: { test: { id: "test", limit: { context: 500000 } }, "test-mini": { id: "test-mini", limit: { context: 500000 } } } }], default: {} }

const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "session-peek-")) : undefined
const app = profile ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" },
}) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const page = app ? await app.firstWindow() : await browser.newPage({ viewport: { width: 1440, height: 900 } })
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
await page.route("**/config/providers*", route => route.fulfill({ json: providers }))
const card = page.locator(".session-peek")
const rowA = page.locator(".session-entry[data-peek-id='ses_a']")
const rowB = page.locator(".session-entry[data-peek-id='ses_b']")
try {
  await page.goto(preview.url)
  await expect(page.locator(".session-info [data-section='context']")).toContainText("1 completed")
  // One number, no breakdown.
  await expect(page.locator(".session-info .info-meter-text")).toHaveText("473k / 500k")
  await expect(page.locator(".session-info .info-meter")).toHaveAttribute("aria-valuetext", "473k of 500k tokens")
  await expect(page.locator(".session-info :is(.ctx-provider, .ctx-legend, .ctx-bar, .ctx-accounting-disclosure)")).toHaveCount(0)
  await expect(page.locator(".session-info [data-section='context'] .info-row", { hasText: "latest" })).toHaveCount(0)
  await expect(card).toHaveCount(0)
  expect(todoCalls("ses_b")).toEqual([])

  // hover expanded row: anchored off the row's end edge; TODOs + one number
  await rowA.hover()
  await expect(card).toHaveCount(1)
  const fact = (label) => card.locator(".peek-facts dt", { hasText: label }).locator("xpath=following-sibling::dd[1]")
  await expect(fact("Context")).toHaveText("473k tokens, last turn")
  await expect(fact("Cost")).toHaveText("$4.20 this session")
  await expect(card.locator(".peek-todos li").first()).toContainText("Wire the peek")
  await expect(card.locator(".peek-todos li").first()).toHaveAttribute("data-status", "in_progress")
  await expect(card.locator(".peek-todos li").nth(1)).toContainText("Verify in RTL مرحبا")
  await expect(card.locator(".peek-todo-done")).toHaveText("✓1 done")
  await expect(card.locator(".peek-todo-basis")).toContainText("list read on open")
  await expect(card).not.toContainText(/donut|composition|cache read/)
  await expect(rowA.locator("a")).toHaveAttribute("aria-describedby", "session-peek")
  const rect = await rowA.boundingBox()
  const cardRect = await card.boundingBox()
  expect(cardRect.x).toBeGreaterThanOrEqual(rect.x + rect.width)
  expect(cardRect.x - (rect.x + rect.width)).toBeLessThan(12)
  expect(Math.abs(cardRect.y - rect.y)).toBeLessThan(10)
  expect(insightCalls().length).toBe(1)
  // An update on the shared stream reaches the open card; no re-read.
  const reads = todoCalls("ses_a").length
  for (const [response, stream] of fixture.eventStreams) if (stream.path === "/global/event")
    response.write(`data: ${JSON.stringify({ directory, payload: { type: "todo.updated", properties: { sessionID: "ses_a", todos: [{ content: "Verify in RTL مرحبا", status: "in_progress", priority: "medium" }] } } })}\n\n`)
  await expect(card.locator(".peek-todos li").first()).toContainText("Verify in RTL")
  await expect(card.locator(".peek-todo-basis")).toContainText("updated")
  expect(todoCalls("ses_a").length).toBe(reads)
  // crossing the gap into the card keeps it open; leaving both closes it
  await page.mouse.move(cardRect.x + 20, cardRect.y + 20)
  await page.waitForTimeout(300)
  await expect(card).toHaveCount(1)
  await page.mouse.move(cardRect.x + 400, cardRect.y + 400)
  await expect(card).toHaveCount(0)
  await expect(rowA.locator("a")).not.toHaveAttribute("aria-describedby", "session-peek")
  // re-hover is served from cache: no second insights request
  await rowA.hover()
  await expect(card).toHaveCount(1)
  expect(insightCalls().length).toBe(1)

  // unknown stays unknown: ses_b has no TODO list or latest turn; never fetches its 4MB transcript
  await page.mouse.move(700, 600)
  await expect(card).toHaveCount(0)
  await rowB.hover()
  await expect(card.locator(".peek-todo-state")).toHaveText("No TODO list")
  await expect(card.locator(".peek-facts dt", { hasText: /Context|Cost/ })).toHaveCount(0)
  expect(messageCalls("ses_b")).toEqual([])
  await page.mouse.move(700, 600)
  await expect(card).toHaveCount(0)

  // keyboard: focus opens, Escape closes and keeps focus on the row
  await rowA.locator("a").focus()
  await expect(card).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(card).toHaveCount(0)
  await expect(rowA.locator("a")).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(card).toHaveCount(1) // focus moved to the pin button, still inside the row
  await page.keyboard.press("Escape")
  await expect(card).toHaveCount(0)

  // pinned row keeps its position while the card is open and activity reorders others
  await rowB.locator(".pin-action").click()
  const pinned = page.locator(".pinned-section .session-entry[data-peek-id='ses_b']")
  await expect(pinned).toHaveCount(1)
  // content-visibility:auto rows report their intrinsic placeholder height until first rendered
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const before = await pinned.boundingBox()
  await pinned.hover()
  await expect(card).toHaveCount(1)
  fixture.emit("session.updated", { info: { ...JSON.parse(JSON.stringify(await (await fetch(`${fixture.url}/session/ses_a`)).json())), time: { created: 1, updated: Date.now() } } })
  await page.waitForTimeout(400)
  expect(await pinned.boundingBox()).toEqual(before)
  await expect(card).toHaveCount(1)
  await page.mouse.move(700, 600)
  await expect(card).toHaveCount(0)
  await pinned.locator(".pin-action").click()
  await expect(page.locator(".pinned-section")).toHaveCount(0)

  // compact rail: mini rows open the same card
  await page.keyboard.press("Control+h")
  const mini = page.locator(".mini-session[data-peek-id='ses_a']")
  await expect(mini).toHaveCount(1)
  await mini.hover()
  await expect(fact("Context")).toHaveText("473k tokens, last turn")
  await expect(fact("Cost")).toHaveText("$4.20 this session")
  const miniRect = await mini.boundingBox()
  expect((await card.boundingBox()).x).toBeGreaterThanOrEqual(miniRect.x + miniRect.width)
  await page.mouse.move(700, 600)
  await expect(card).toHaveCount(0)
  await page.keyboard.press("Control+h")

  // RTL: the card sits on the row's inline-end (visual left) side
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await rowA.hover()
  await expect(card).toHaveCount(1)
  const rtlRow = await rowA.boundingBox()
  const rtlCard = await card.boundingBox()
  expect(rtlCard.x + rtlCard.width).toBeLessThanOrEqual(rtlRow.x + 1)
  await expect(card).toHaveAttribute("data-side", "end")
   await page.mouse.move(700, 600)
   await expect(card).toHaveCount(0)
   await page.evaluate(() => { document.documentElement.dir = "ltr" })

  // degraded: insights endpoint missing -> bounded tail only, still one number; TODOs unaffected
  fixture.insights = undefined
  fixture.calls.length = 0
  await page.reload()
  await expect(page.locator(".session-info [data-section='context']")).toContainText("1 completed")
  await rowB.hover()
  await expect(fact("Context")).toHaveText("1.1k tokens, last turn")
  const tail = messageCalls("ses_b")
  expect(tail.length).toBe(1)
  expect(tail[0].limit).toBe("6")
  expect(insightCalls().length).toBe(1) // probed once, then backed off
  await page.mouse.move(700, 600)
  await rowA.hover()
  await expect(card.locator(".peek-todos li").first()).toContainText("Wire the peek")
  expect(insightCalls().length).toBe(1)
  await page.mouse.move(700, 600)

  // All scope: rows carry no project subtitle; the card names the project; hovering adds no requests.
  await page.locator(".es-switcher").selectOption("__all__")
  await expect(rowA.locator(".session-project")).toHaveCount(0)
  await expect(rowA.locator(".sr-only")).toHaveCount(1)
  const callsBefore = fixture.calls.length
  await rowA.hover()
  await expect(card.locator(".peek-facts dt", { hasText: "Project" })).toHaveCount(1)
  await page.mouse.move(700, 600)
  await rowA.locator("a").focus()
  await expect(card.locator(".peek-facts")).toBeVisible()
  await page.keyboard.press("Escape")
  expect(fixture.calls.slice(callsBefore).filter((c) => !/\/event|\/session\/status|\/api\/(state|events)/.test(c.path)).map((c) => c.path)).toEqual([])
  if (process.env.PEEK_SHOTS) {
    for (const [name, row] of [["all-1440", rowA], ["all-1440-sparse", rowB]]) {
      await row.hover(); await expect(card).toHaveCount(1); await page.waitForTimeout(300)
      await page.screenshot({ path: `${process.env.PEEK_SHOTS}/${name}.png`, clip: { x: 0, y: 180, width: 560, height: 260 } })
      await page.mouse.move(700, 600); await expect(card).toHaveCount(0)
    }
  }

  // 390px RTL: the panel's single number fits without horizontal scroll
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await expect(page.locator(".session-info .info-meter-text")).toContainText("/")
  expect(await page.locator(".session-info").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  if (process.env.PEEK_SHOTS) {
    await page.locator(".session-entry[data-peek-id='ses_a'] a").first().focus()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${process.env.PEEK_SHOTS}/all-390-rtl.png` })
  }
   expect(fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
   console.log(`PASS session peek ${app ? "native" : "browser"}: persisted TODOs + one token number, stream update without re-read, aria-describedby, hover/focus/Escape, gap, cache, unknowns, pin stability, compact, RTL/mobile, degraded tail, zero mutations`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}
