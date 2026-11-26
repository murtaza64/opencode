// Compact session pages (DD #625): the transcript asks Core for compact pages; a tool's large image comes as Core's
// attachment route and loads only when that call is opened; a shortened tool output loads its full text on request;
// an older Core that ignores the parameter keeps working. The page's message reads are answered here (the fixture
// Core serves everything else). Run from packages/es-app: node test/compact-messages.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
// One 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
const big = `data:image/png;base64,${PNG.toString("base64")}${"A".repeat(400_000)}`
const fullOutput = `${"head line\n".repeat(2000)}MIDDLE-MARKER\n${"tail line\n".repeat(2000)}`
const route = "/session/ses_a/message/msg_t/part/prt_t/attachment/0"
const user = { info: { id: "msg_u", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: 1 } },
  parts: [{ id: "prt_u", sessionID: "ses_a", messageID: "msg_u", type: "text", text: "Read the screenshot." }] }
const assistant = (state) => ({
  info: { id: "msg_t", sessionID: "ses_a", role: "assistant", agent: "build", parentID: "msg_u", providerID: "fixture", modelID: "test", mode: "build",
    path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 2, completed: 3 } },
  parts: [{ id: "prt_t", sessionID: "ses_a", messageID: "msg_t", type: "tool", tool: "bash", callID: "call_t",
    state: { status: "completed", input: { command: "cat log", description: "Read the log" }, title: "cat log", time: { start: 2, end: 3 }, ...state } }],
})
const full = assistant({ output: fullOutput, metadata: {}, attachments: [{ id: "f", sessionID: "ses_a", messageID: "msg_t", type: "file", mime: "image/png", filename: "shot.png", url: big }] })
const compact = assistant({ output: `${fullOutput.slice(0, 4096)}\n… [omitted] …\n${fullOutput.slice(-4096)}`,
  metadata: { pageTruncated: { output: fullOutput.length, attachments: [{ index: 0, urlLength: big.length }] } },
  attachments: [{ id: "f", sessionID: "ses_a", messageID: "msg_t", type: "file", mime: "image/png", filename: "shot.png", url: route }] })

const state = { oldCore: false }
const seen = { pages: [], pageBytes: [], single: 0, attachment: 0 }
await page.route((url) => new URL(url).pathname === "/oc/session/ses_a/message", async (route) => {
  const url = new URL(route.request().url())
  seen.pages.push(url.searchParams.get("compact"))
  const body = JSON.stringify([user, !state.oldCore && url.searchParams.get("compact") === "true" ? compact : full])
  seen.pageBytes.push(body.length)
  return route.fulfill({ contentType: "application/json", body })
})
await page.route((url) => new URL(url).pathname === "/oc/session/ses_a/message/msg_t", (route) => { seen.single += 1; return route.fulfill({ json: full }) })
await page.route((url) => new URL(url).pathname === `/oc${route}`, (r) => { seen.attachment += 1; return r.fulfill({ contentType: "image/png", body: PNG }) })

const results = []
const step = (name) => results.push(`PASS ${name}`)
const call = page.locator('[data-timeline-part-id="prt_t"]').first()
try {
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(call).toBeVisible()
  if (!seen.pages.every((value) => value === "true")) throw new Error(`page reads without compact: ${JSON.stringify(seen.pages)}`)
  if (Math.max(...seen.pageBytes) > 20_000) throw new Error(`page bytes ${seen.pageBytes}`)
  if (seen.attachment) throw new Error("image fetched before the call was opened")
  step(`transcript reads compact pages (${Math.max(...seen.pageBytes)} bytes vs ${JSON.stringify([user, full]).length} full); no image fetched while the call is closed`)

  await call.locator("button").first().click()
  const image = page.locator(`[data-tool-attachments="prt_t"] img`)
  await expect(image).toHaveAttribute("src", `/oc${route}`)
  await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBe(1)
  if (seen.attachment !== 1) throw new Error(`attachment reads ${seen.attachment}`)
  step("opening the call loads the image once from its attachment route")

  const more = page.getByRole("button", { name: /Show full output/ })
  await expect(more).toBeVisible()
  // Open the shell card's output inside the call.
  await call.locator('[data-slot="basic-tool-tool-info-structured"]').first().click()
  await expect(call.getByText("[omitted]", { exact: false }).first()).toBeAttached()
  await expect(page.getByText("MIDDLE-MARKER")).toHaveCount(0)
  await more.click()
  await expect(page.getByText("MIDDLE-MARKER").first()).toBeAttached()
  if (seen.single !== 1) throw new Error(`full message reads ${seen.single}`)
  await expect(more).toHaveCount(0)
  step("a shortened output loads its full text on request, with one message read")

  state.oldCore = true
  seen.attachment = 0
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(call).toBeVisible()
  await call.locator("button").first().click()
  await expect(page.locator(`[data-tool-attachments="prt_t"] img`)).toHaveAttribute("src", /^data:image\/png;/)
  await expect(page.getByRole("button", { name: /Show full output/ })).toHaveCount(0)
  if (seen.attachment) throw new Error("old Core: attachment route read")
  step("an older Core (full page) renders as before: inline image, no Show full output")
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`)
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n")[0]} seen=${JSON.stringify(seen)}`)
} finally {
  console.log(results.join("\n"))
  await browser.close()
  await preview.close()
}
