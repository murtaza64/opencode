/* Sidebar hover card + right-panel context section (dotfiles#140): anchored
 * card on hover/focus with exact cost/turns/model and estimated composition,
 * no hover-gap disappearance, Escape, compact rail, RTL side, pinned-row
 * stability under activity, unknown data stays unknown, bounded fetches
 * (never a full transcript for a hovered row), degraded mode when the
 * dashboard endpoint is missing. */
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const tokens = { input: 52000, output: 1800, reasoning: 600, cache: { read: 70000, write: 4000 } }
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
const providers = { providers: [{ id: "fixture", models: { test: { id: "test", limit: { context: 200000 } }, "test-mini": { id: "test-mini", limit: { context: 200000 } } } }], default: {} }

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
  await expect(page.locator(".session-info .ctx-exact")).toContainText("128k / 200k (64%)")
  await expect(page.locator(".session-info .ctx-legend li", { hasText: "tool output" })).toContainText("10k")
  await expect(page.locator(".session-info .ctx-legend li", { hasText: "other" })).toContainText("92%")
  await expect(page.locator(".session-info .ctx-caption")).toContainText("Not provider token attribution")
  await expect(page.locator(".session-info [data-section='context'] .info-row", { hasText: "latest" })).toHaveCount(0)
  await expect(card).toHaveCount(0)

  // hover expanded row: anchored off the row's end edge, data from insights
  await rowA.hover()
  await expect(card).toHaveCount(1)
  await expect(card.locator("[data-fact='cost']")).toHaveText("$4.20")
  await expect(card.locator("[data-fact='turns']")).toHaveText("12")
  await expect(card.locator("[data-fact='model']")).toHaveText("test")
  await expect(card.locator("[data-fact='latest']")).toHaveText("test-mini")
  await expect(card.locator(".ctx-donut-label")).toHaveText("64%")
  await expect(card.locator(".ctx-donut-seg")).toHaveCount(5)
  await expect(card.locator(".ctx-dots li", { hasText: "output" })).toContainText("47%")
  await expect(card.locator(".peek-context")).toContainText("ctx 128k / 200k")
  await expect(card).toContainText("since last compaction")
  await expect(card.locator(".peek-degraded")).toHaveCount(0)
  const rect = await rowA.boundingBox()
  const cardRect = await card.boundingBox()
  expect(cardRect.x).toBeGreaterThanOrEqual(rect.x + rect.width)
  expect(cardRect.x - (rect.x + rect.width)).toBeLessThan(12)
  expect(Math.abs(cardRect.y - rect.y)).toBeLessThan(10)
  expect(insightCalls().filter((c) => c.path && fixture.calls.length).length).toBe(1)
  expect(messageCalls("ses_a").filter((c) => c.path).length).toBeGreaterThan(0) // the open transcript itself
  // crossing the gap into the card keeps it open; leaving both closes it
  await page.mouse.move(cardRect.x + 20, cardRect.y + 20)
  await page.waitForTimeout(300)
  await expect(card).toHaveCount(1)
  await page.mouse.move(cardRect.x + 400, cardRect.y + 400)
  await expect(card).toHaveCount(0)
  // re-hover is served from cache: no second insights request
  await rowA.hover()
  await expect(card).toHaveCount(1)
  expect(insightCalls().length).toBe(1)

  // unknown stays unknown: ses_b has no latest turn/limit; never fetches its 4MB transcript
  await rowB.hover()
  await expect(card.locator("[data-fact='turns']")).toHaveText("0")
  await expect(card.locator("[data-fact='cost']")).toHaveText("unknown")
  await expect(card.locator("[data-fact='model']")).toHaveText("unknown")
  await expect(card.locator(".ctx-donut-label")).toHaveText("?")
  await expect(card.locator(".peek-context")).toContainText("latest turn context unknown")
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
  await expect(card.locator("[data-fact='turns']")).toHaveText("12")
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

  // degraded: endpoint missing -> bounded tail only, labelled, no transcript fetch
  fixture.insights = undefined
  fixture.calls.length = 0
  await page.reload()
  await expect(page.locator(".session-info [data-section='context']")).toContainText("1 completed")
  await rowB.hover()
  await expect(card.locator("[data-fact='turns']")).toHaveText("unknown")
  await expect(card.locator(".peek-degraded")).toContainText("insights API offline")
  await expect(card.locator(".peek-context")).toContainText("ctx 1.1k")
  await expect(card.locator(".peek-context")).toContainText("limit unknown")
  await expect(card.locator(".ctx-donut-label")).toHaveText("?")
  await expect(card.locator("[data-fact='latest']")).toHaveText("mystery")
  const tail = messageCalls("ses_b")
  expect(tail.length).toBe(1)
  expect(fixture.calls.find((c) => c.path === "/session/ses_b/message")).toBeTruthy()
  expect(tail[0].limit).toBe("6")
  expect(insightCalls().length).toBe(1) // probed once, then backed off
  await page.mouse.move(700, 600)
  await rowA.hover()
  await expect(card).toHaveCount(1)
  expect(insightCalls().length).toBe(1)
  await page.mouse.move(700, 600)

  // open session with a compaction summary: panel scopes the estimate to the retained window
  fixture.messages.unshift(
    { info: { id: "old_u", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: 0 } },
      parts: [{ id: "old_up", messageID: "old_u", sessionID: "ses_a", type: "text", text: "z".repeat(80000) }] },
    { info: { id: "sum_a", sessionID: "ses_a", role: "assistant", parentID: "old_u", summary: true, agent: "compaction", providerID: "fixture", modelID: "test",
        path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 0, completed: 1 } },
      parts: [{ id: "sum_ap", messageID: "sum_a", sessionID: "ses_a", type: "text", text: "summary".repeat(100) }] },
  )
  await page.reload()
  await expect(page.locator(".session-info [data-section='context']")).toContainText("2 completed")
  await expect(page.locator(".session-info .ctx-caption")).toContainText("since the last compaction")
  await expect(page.locator(".session-info .ctx-legend li", { hasText: "user text" })).not.toContainText("20k")
  expect(fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log(`PASS session peek ${app ? "native" : "browser"}: hover/focus/Escape, gap, cache, unknowns, pin stability, compact, RTL, degraded tail (limit=6, one probe), compaction scope, zero mutations`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}
