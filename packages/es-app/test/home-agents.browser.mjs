// Front desk permission replies against the disposable fixture daemon.
// Run from packages/es-app: node test/home-agents.browser.mjs
import { createRequire } from "node:module"
import path from "node:path"
import { tmpdir } from "node:os"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const artifacts = process.env.HOME_AGENTS_ARTIFACTS ?? tmpdir()
const preview = await startAttentionPreview()
const fixture = preview.fixture
const permission = (id, sessionID, command, always = [`${command.split(" ")[0]} *`]) => ({ id, sessionID, permission: "bash", patterns: [command], always, metadata: { command, description: `Synthetic ${id}` } })
fixture.strictPermissionReply = true
fixture.permissions = [permission("per_home", "ses_b", "bun test"), permission("per_other", "ses_a", "git status")]
fixture.todos = new Map([["ses_a", [
  { content: "Read the Home design", status: "completed", priority: "high" },
  { content: "Wire permission replies", status: "in_progress", priority: "high" },
  { content: "Verify in RTL", status: "pending", priority: "medium" },
]], ["ses_b", [{ content: "Unpinned work", status: "in_progress", priority: "low" }]]])

const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const replies = []
page.on("request", (request) => {
  const match = /\/oc\/permission\/([^/]+)\/reply\?(.*)$/.exec(request.url())
  if (match && request.method() === "POST") replies.push({ id: match[1], directory: new URLSearchParams(match[2]).get("directory"), body: request.postDataJSON() })
})
const emit = (type, properties) => {
  for (const [response, stream] of fixture.eventStreams) if (stream.path === "/global/event") response.write(`data: ${JSON.stringify({ directory, payload: { type, properties } })}\n\n`)
}
const card = (id) => page.locator(`.home-permission[data-request-id="${id}"]`)
const queued = (id) => page.locator(`.desk-item[data-desk-item="permission:${directory}:${id}"]`)
const select = async (id) => { await queued(id).click(); await expect(card(id)).toBeVisible() }
const refresh = () => page.getByRole("button", { name: "Refresh", exact: true }).click()
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  // A cold Vite dependency optimization can delay the first render.
  await expect(queued("per_home")).toBeVisible({ timeout: 90_000 })
  await expect(queued("per_other")).toBeVisible()
  await page.screenshot({ path: path.join(artifacts, "home-agents-ltr.png"), fullPage: true })

  // Context: tool, exact request/session identity, patterns, metadata and cascade semantics.
  await select("per_home")
  await expect(card("per_home").locator(".home-eyebrow")).toHaveText("bash")
  await expect(card("per_home")).toHaveAttribute("data-request-id", "per_home")
  await expect(card("per_home").getByRole("link", { name: "Open thread" })).toHaveAttribute("href", /ses_b/)
  await expect(card("per_home").locator(".home-permission-context")).toContainText("bun test")
  await expect(card("per_home").locator(".home-permission-context")).toContainText("Synthetic per_home")
  await expect(card("per_home")).toContainText("Always allow: bun * in this project")

  // Exact single reply: only per_home, once, with its own directory. The card stays put with its outcome.
  await card("per_home").getByRole("button", { name: "Allow once", exact: true }).click()
  await expect(page.locator(".home-receipts")).toContainText("Allowed once · bash")
  expect(replies).toEqual([{ id: "per_home", directory, body: { reply: "once" } }])
  emit("permission.replied", { sessionID: "ses_b", requestID: "per_home", reply: "once" })
  await expect(queued("per_home")).toHaveCount(0)
  // A settled request keeps its card with what was sent, and no reply controls.
  await expect(card("per_home").locator(".home-permission-status")).toHaveText("Allowed once from here.")
  await expect(card("per_home").locator(".home-actions button")).toHaveCount(0)
  await select("per_other")
  await expect(card("per_other").getByRole("button", { name: "Allow once", exact: true })).toBeEnabled()

  // Double click while the reply is in flight sends one request.
  fixture.holdPermissionReply = true
  await card("per_other").getByRole("button", { name: "Reject", exact: true }).dblclick()
  await expect(card("per_other").locator(".home-permission-status")).toContainText("Sending reject")
  await expect(card("per_other").getByRole("button", { name: "Always allow", exact: true })).toBeDisabled()
  await page.waitForTimeout(300)
  expect(replies.filter((reply) => reply.id === "per_other")).toEqual([{ id: "per_other", directory, body: { reply: "reject" } }])
  fixture.holdPermissionReply = false
  fixture.permissionReplyQueue.shift()()
  await expect(page.locator(".home-receipts li").first()).toContainText("Rejected · bash")
  emit("permission.replied", { sessionID: "ses_a", requestID: "per_other", reply: "reject" })
  await expect(queued("per_other")).toHaveCount(0)

  // Stale: answered elsewhere without an event reaching this client -> 404, not applied.
  fixture.permissions = [permission("per_stale", "ses_b", "rm -rf build")]
  emit("permission.asked", fixture.permissions[0])
  await select("per_stale")
  await expect(card("per_stale").getByRole("button", { name: "Allow once", exact: true })).toBeEnabled()
  fixture.permissions = []
  await card("per_stale").getByRole("button", { name: "Always allow", exact: true }).click()
  await expect(page.locator(".home-receipts li").first()).toContainText("Not applied · bash")
  await expect(page.locator(".home-receipts li").first()).toContainText("no longer pending")
  await expect(queued("per_stale")).toHaveCount(0)

  // Uncertain: server/network failure is not success; reply again only after a recheck confirms pending.
  fixture.permissions = [permission("per_flaky", "ses_b", "bun run build")]
  emit("permission.asked", fixture.permissions[0])
  await select("per_flaky")
  fixture.failPermissionReply = true
  await card("per_flaky").getByRole("button", { name: "Allow once", exact: true }).click()
  await expect(page.locator(".home-receipts li").first()).toContainText("Outcome uncertain")
  await expect(card("per_flaky").locator(".home-permission-status")).toHaveText("Reply not confirmed; still pending. You can reply again.")
  fixture.failPermissionReply = false
  await card("per_flaky").getByRole("button", { name: "Allow once", exact: true }).click()
  await expect(page.locator(".home-receipts li").first()).toContainText("Allowed once")
  expect(replies.filter((reply) => reply.id === "per_flaky").length).toBe(2)

  // Offline source: an unverifiable request is link-only until a later check confirms it pending.
  fixture.permissions = [permission("per_offline", "ses_b", "bun lint")]
  emit("permission.asked", fixture.permissions[0])
  await select("per_offline")
  fixture.failPermissionList = true
  await refresh()
  await expect(queued("per_offline")).toHaveCount(0)
  await expect(card("per_offline").locator(".home-actions button")).toHaveCount(0)
  await expect(card("per_offline").locator(".home-permission-state")).toContainText("Can't reach this project.")
  await expect(page.locator(".home-unknown")).toContainText("source unavailable")
  await expect(page.locator(".home-unknown button")).toHaveCount(0)
  fixture.failPermissionList = false
  await refresh()
  await expect(card("per_offline").getByRole("button", { name: "Allow once", exact: true })).toBeEnabled()
  expect(replies.some((reply) => reply.id === "per_offline")).toBe(false)
  fixture.permissions = []
  emit("permission.replied", { sessionID: "ses_b", requestID: "per_offline", reply: "reject" })
  await expect(queued("per_offline")).toHaveCount(0)

  // Resolved elsewhere with a live event: the item leaves without any reply from the desk.
  fixture.permissions = [permission("per_elsewhere", "ses_b", "echo hi")]
  emit("permission.asked", fixture.permissions[0])
  await expect(queued("per_elsewhere")).toBeVisible()
  fixture.permissions = []
  emit("permission.replied", { sessionID: "ses_b", requestID: "per_elsewhere", reply: "once" })
  await expect(queued("per_elsewhere")).toHaveCount(0)
  expect(replies.some((reply) => reply.id === "per_elsewhere")).toBe(false)

  // RTL and narrow layouts keep commands LTR and actions reachable.
  fixture.permissions = [permission("per_rtl", "ses_b", "git push origin مرحبا")]
  emit("permission.asked", fixture.permissions[0])
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await select("per_rtl")
  const command = card("per_rtl").locator(".home-permission-context bdi.mono").first()
  expect(await command.evaluate((element) => element.getAttribute("dir"))).toBe("ltr")
  expect(await card("per_rtl").evaluate((element) => getComputedStyle(element).borderInlineStartWidth)).toBe("2px")
  expect(await card("per_rtl").evaluate((element) => getComputedStyle(element).borderRightWidth)).toBe("2px")
  await page.screenshot({ path: path.join(artifacts, "home-agents-rtl.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 900 })
  await card("per_rtl").getByRole("button", { name: "Reject", exact: true }).scrollIntoViewIfNeeded()
  await expect(card("per_rtl").getByRole("button", { name: "Reject", exact: true })).toBeInViewport()
  await page.screenshot({ path: path.join(artifacts, "home-agents-mobile-rtl.png"), fullPage: true })
  expect(errors).toEqual([])
  console.log(`PASS front desk permission replies; screenshots in ${artifacts}`)
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, "home-agents-failure.png"), fullPage: true }).catch(() => undefined)
  console.error(error, errors)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close()
}
