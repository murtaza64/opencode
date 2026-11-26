// The Surface micro chat opens on the author session's real history about this Surface (Laptop .05.1): the assistant
// step that published/announced it (a publish call naming the Surface, or a surface:<id> ref) plus the reader's
// Surface-context exchanges, chronological and scrolled to the newest, capped at 10 with "Earlier in full chat".
// Loading is truthful, an unsent draft survives the load, and no message is invented. Fixtures only.
// Run from packages/es-app: node test/surface-chat-history.browser.mjs [--shots DIR]
import path from "node:path"
import { createRequire } from "node:module"
import { injectBridge } from "../surface-bridge.ts"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startPanelPreview()
preview.fixture.laneOwners = [{ lane: "ux-feel", owner: "ses_a" }]
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const now = Date.now()
const SURFACE = { id: "review", title: "Design review", summary: null, kind: "path", owner: "opencode/ux-feel", lane: "ux-feel", editspace: "fixture", updated_at: now, revision: 4, health: { state: "ok" } }
const PAGE = injectBridge(`<!doctype html><html><head><meta charset="utf-8"><style>body{font:15px sans-serif;margin:24px;background:#16161a;color:#ddd}</style></head><body><h1>Design review</h1><p>Body.</p></body></html>`)
const about = (revision) => ({ type: "text", synthetic: true, text: `Context the person attached: ${JSON.stringify({ kind: "surface", id: "review", host: "fixture", revision })}` })
const user = (id, text, revision, at) => ({ info: { id, sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: at } },
  parts: [{ id: `prt_${id}`, sessionID: "ses_a", messageID: id, type: "text", text }, { id: `prt_${id}_ctx`, sessionID: "ses_a", messageID: id, ...about(revision) }] })
const reply = (id, parentID, text, at) => ({ info: { id, sessionID: "ses_a", role: "assistant", agent: "build", parentID, providerID: "fixture", modelID: "test", mode: "build", path: { cwd: directory, root: directory }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: at, completed: at + 1000 } }, parts: [{ id: `prt_${id}`, sessionID: "ses_a", messageID: id, type: "text", text }] })
// The step that published the Surface: a shell publish call that names the id, and the text that announced it.
const publish = {
  info: { id: "msg_0publish", sessionID: "ses_a", role: "assistant", agent: "build", parentID: "msg_0request", providerID: "fixture", modelID: "test", mode: "build",
    path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now - 900_000, completed: now - 899_000 } },
  parts: [
    { id: "prt_publish", sessionID: "ses_a", messageID: "msg_0publish", type: "tool", tool: "bash", callID: "call_publish",
      state: { status: "completed", input: { command: "es surface publish --id review --title 'Design review'" }, output: "Published: surface:review@r1", metadata: { exit: 0 }, title: "", time: { start: now - 900_000, end: now - 899_000 } } },
    { id: "prt_publish_text", sessionID: "ses_a", messageID: "msg_0publish", type: "text", text: "Published the Design review: surface:review r1." },
  ],
}
// A publish done by tool call alone: no text announces it, so this row can only come from the publish-call match.
const publishToolOnly = {
  info: { id: "msg_0tool", sessionID: "ses_a", role: "assistant", agent: "build", parentID: "msg_0request", providerID: "fixture", modelID: "test", mode: "build",
    path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now - 950_000, completed: now - 949_000 } },
  parts: [{ id: "prt_publish_tool", sessionID: "ses_a", messageID: "msg_0tool", type: "tool", tool: "bash", callID: "call_publish_tool",
    state: { status: "completed", input: { command: "es surface publish --id review" }, output: "surface:review@r1", metadata: { exit: 0 }, title: "", time: { start: now - 950_000, end: now - 949_000 } } }],
}
const exchange = [user("msg_1ask", "Why is the summary below the fold?", 3, now - 600_000), reply("msg_2reply", "msg_1ask", "Moved it to the top in r4.", now - 500_000)]
const history = () => [
  { info: { id: "msg_0other", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: now - 1_000_000 } }, parts: [{ id: "prt_0other", sessionID: "ses_a", messageID: "msg_0other", type: "text", text: "Unrelated task" }] },
  publishToolOnly,
  publish,
  ...exchange,
]

const open = async (options) => {
  preview.fixture.messages = options.messages
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [SURFACE] } }))
  await page.route("**/__es/surface/review", (route) => route.fulfill({ json: { src: "/__fixture/review/", expires_at: now + 600_000 } }))
  await page.route("**/__fixture/review/", (route) => route.fulfill({ contentType: "text/html", headers: { "content-security-policy": "sandbox allow-scripts allow-forms" }, body: PAGE }))
  await page.route((url) => new URL(url).pathname === "/es/api/surfaces/review/comments", (route) => route.fulfill({ json: { schema: "es-surface-comments/1", surface_id: "review", comments: [] } }))
  await page.route((url) => new URL(url).pathname.startsWith("/oc/session/ses_a/message"), async (route) => {
    if (options.fail) return route.fulfill({ status: 500, json: { error: "fixture history unavailable" } })
    if (options.hold) await new Promise((resolve) => setTimeout(resolve, 1200))
    return route.continue()
  })
  await page.goto(`${preview.origin}/?surface=review`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(page.getByRole("button", { name: /^Comment \(C\)/ })).toBeEnabled({ timeout: 120_000 })
  await page.locator(".sc-tool-chat").click()
  await expect(page.locator(".sc-chat")).toBeVisible()
  return { page, context, errors }
}
const shot = async (page, name) => { if (shots) await page.locator(".sc-chat").screenshot({ path: path.join(shots, `${name}.png`) }) }

try {
  // Published then opened: the real publish step and the context exchange, chronological; the unrelated task stays out.
  {
    const { page, context, errors } = await open({ messages: history(), hold: true })
    const chat = page.locator(".sc-chat")
    await expect(chat.locator(".sc-chat-empty", { hasText: "Loading the chat…" })).toBeVisible()
    const draft = chat.locator("textarea")
    await draft.fill("draft while the history loads")
    await expect(chat).toContainText("Published the Design review", { timeout: 30_000 })
    await expect(draft).toHaveValue("draft while the history loads")
    await expect(chat).toContainText("Why is the summary below the fold?")
    await expect(chat).toContainText("Moved it to the top in r4.")
    await expect(chat).not.toContainText("Unrelated task")
    // The publish tool itself is real history, not a synthetic row (two publish steps and the reply).
    await expect(chat.locator(".sc-chat-msg[data-role=assistant]")).toHaveCount(3)
    await expect(chat.locator('[data-component="tool-part-wrapper"]')).toHaveCount(2)
    await expect(chat.getByRole("link", { name: "Open full chat ↗" })).toBeVisible()
    // The unsent draft survives minimize -> reopen.
    await chat.getByRole("button", { name: "Minimise chat" }).click()
    await expect(chat).toHaveClass(/sc-chat-min/)
    await page.locator(".sc-tool-chat").click()
    await expect(chat).not.toHaveClass(/sc-chat-min/)
    await expect(draft).toHaveValue("draft while the history loads")
    await shot(page, "history-published")
    expect(errors).toEqual([])
    await context.close()
  }

  // No prior messages: the empty state is true, not a placeholder over hidden history.
  {
    const { page, context, errors } = await open({ messages: [] })
    await expect(page.locator(".sc-chat")).toContainText("Ask about this Surface; replies show here.", { timeout: 30_000 })
    await expect(page.locator(".sc-chat")).not.toContainText("Published the Design review")
    expect(errors).toEqual([])
    await context.close()
  }

  // More than the cap: the newest 10, scrolled to the end, with the way to the full chat for the rest.
  {
    const many = [publish]
    for (let index = 0; index < 12; index++) {
      many.push(user(`msg_${index}_u`, `Question ${index}`, 4, now - 400_000 + index * 1000))
      many.push(reply(`msg_${index}_a`, `msg_${index}_u`, `Answer ${index}`, now - 399_500 + index * 1000))
    }
    const { page, context, errors } = await open({ messages: many })
    const chat = page.locator(".sc-chat")
    await expect(chat.locator(".sc-chat-earlier")).toHaveText("Earlier in full chat ↗")
    await expect(chat.locator(".sc-chat-msg")).toHaveCount(10)
    await expect(chat).toContainText("Question 11")
    await expect(chat).not.toContainText("Question 0")
    await expect.poll(() => chat.locator(".sc-chat-body").evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)).toBe(true)
    await shot(page, "history-capped")
    expect(errors).toEqual([])
    await context.close()
  }

  // A failed history read is an error, not the "ask" prompt.
  {
    const { page, context, errors } = await open({ messages: history(), fail: true })
    await expect(page.locator(".sc-chat")).toContainText("unreachable", { timeout: 30_000 })
    await expect(page.locator(".sc-chat")).not.toContainText("Ask about this Surface; replies show here.")
    expect(errors).toEqual([])
    await context.close()
  }

  console.log("PASS Surface micro chat history: publish/announce step and context exchanges load chronologically, draft survives loading/minimize, true empty state, 10-message cap with full-chat link, truthful load error")
} finally {
  await browser.close()
  await preview.close()
}
