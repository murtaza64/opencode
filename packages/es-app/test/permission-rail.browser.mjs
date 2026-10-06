// #156: permission actions live in a sticky rail at the top of each request —
// identity, a one-line gist and allow/always/reject stay reachable while long
// details scroll beneath; multiple requests and child owners stay distinct.
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const child = { ...session("ses_child"), title: "Explore child", parentID: "ses_a" }
fixture.workspaceSessions.push(child)
const longCommand = `find . -name '*.ts' -not -path './node_modules/*' -exec grep -l 'createSignal' {} + | xargs wc -l | sort -n | tail -40 && echo ${"very-long-argument-".repeat(12)}done`
const gate = {
  id: "per_long", sessionID: "ses_a", permission: "bash", patterns: [longCommand], always: [],
  metadata: { command: longCommand, cwd: "/fixture with spaces/a&b?#", description: "Count createSignal usages across the tree",
    ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`detail_${i}`, `metadata row ${i} ${"x".repeat(60)}`])) },
}
const childGate = { id: "per_child", sessionID: "ses_child", permission: "external_directory", patterns: [], always: [],
  metadata: { directories: ["/outside/one", "/outside/two"] } }
fixture.permissions = [gate, childGate]
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "permission-rail-")) : undefined
const app = profile ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" } }) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const context = app ? app.context() : await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = app ? await app.firstWindow() : await context.newPage()
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
const replies = () => fixture.calls.filter((call) => call.method === "POST" && /^\/permission\/[^/]+\/reply$/.test(call.path))
const otherWrites = () => fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method) && !/^\/permission\/[^/]+\/reply$/.test(call.path))
const alerts = page.locator(".session-alerts")
const main = page.locator(".banner.permission", { hasText: "permission: bash" })
const fromChild = page.locator(".banner.permission", { hasText: "external_directory" })
const visibleInAlerts = async (locator) => {
  const [box, strip] = await Promise.all([locator.boundingBox(), alerts.boundingBox()])
  return !!box && box.y >= strip.y - 1 && box.y + box.height <= strip.y + strip.height + 1
}
const shot = async (name) => { if (process.env.PERMISSION_RAIL_SHOTS) await page.screenshot({ path: `${process.env.PERMISSION_RAIL_SHOTS}-${name}.png` }) }
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  await editor.fill("Draft stays while gates are decided")
  await expect(main).toBeVisible()
  await expect(fromChild).toBeVisible()
  await expect(main).toHaveAttribute("aria-label", "Permission bash")
  await expect(fromChild).toHaveAttribute("aria-label", "Permission external_directory from subagent Explore child")
  await expect(fromChild.locator(".permission-owner")).toHaveText("from subagent: Explore child")

  // Rail shows identity + gist + actions; details are collapsed by default and expand to the full metadata.
  const rail = main.locator(".permission-rail")
  await expect(rail.locator(".permission-summary")).toContainText("find . -name")
  const once = main.getByRole("button", { name: "allow once" })
  const always = main.getByRole("button", { name: "always" })
  const reject = main.getByRole("button", { name: "reject" })
  await expect(once).toBeVisible()
  await expect(always).toBeVisible()
  await expect(reject).toBeVisible()
  expect(await visibleInAlerts(once)).toBe(true)
  const details = main.locator("details.permission-details")
  expect(await details.evaluate((el) => el.open)).toBe(false)
  await details.locator("summary").click()
  await expect(details).toContainText("detail_23:")
  await expect(details).toContainText("cwd:")
  await shot("expanded")

  // Scroll the long details inside the alerts strip: actions remain pinned in view, no transcript/editor overlap.
  const stripBox = await alerts.boundingBox()
  await alerts.evaluate((el) => { el.scrollTop = el.scrollHeight })
  expect(await alerts.evaluate((el) => el.scrollTop)).toBeGreaterThan(50)
  const railBox = await rail.boundingBox()
  expect(railBox.y).toBeGreaterThanOrEqual(stripBox.y - 1)
  expect(railBox.y).toBeLessThanOrEqual(stripBox.y + 2)
  expect(await visibleInAlerts(once)).toBe(true)
  const transcriptBox = await page.locator(".session-page .transcript").boundingBox()
  expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(transcriptBox.y + 1)
  await shot("scrolled")
  await alerts.evaluate((el) => { el.scrollTop = 0 })

  // Keyboard: Tab order reaches the actions; Enter on a focused button sends exactly one reply.
  fixture.holdPermissionReply = true
  await once.focus()
  await page.keyboard.press("Enter")
  await expect(once).toBeDisabled()
  await expect(always).toBeDisabled()
  await expect(reject).toBeDisabled()
  await once.click({ force: true })
  await page.waitForTimeout(100)
  expect(replies()).toHaveLength(1)
  expect(replies()[0].body).toEqual({ reply: "once" })
  // the child request is untouched by the parent's pending reply
  await expect(fromChild.getByRole("button", { name: "reject" })).toBeEnabled()
  fixture.holdPermissionReply = false
  fixture.permissionReplyQueue.shift()()
  await expect(main).toHaveCount(0)
  await expect(fromChild).toBeVisible()
  await expect(editor).toHaveValue("Draft stays while gates are decided")

  // Error path keeps the request, surfaces the failure inline and allows a retry.
  fixture.failPermissionReply = true
  await fromChild.getByRole("button", { name: "reject" }).click()
  await expect(fromChild.getByRole("alert")).toContainText("HTTP 503")
  await expect(fromChild.getByRole("button", { name: "reject" })).toBeEnabled()
  fixture.failPermissionReply = false
  await shot("error")
  await fromChild.getByRole("button", { name: "reject" }).click()
  await expect(fromChild).toHaveCount(0)
  expect(replies().map((call) => call.body.reply)).toEqual(["once", "reject", "reject"])
  expect(fixture.permissionReplies).toEqual([{ id: "per_long", reply: "once" }, { id: "per_child", reply: "reject" }])

  // Mobile + RTL: stacked rail, buttons reachable, no horizontal overflow.
  fixture.permissions = [gate]
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(main).toBeVisible()
  await page.setViewportSize({ width: 390, height: 780 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await expect(main.getByRole("button", { name: "allow once" })).toBeVisible()
  const size = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  expect(size.scroll).toBeLessThanOrEqual(size.client)
  await shot("mobile-rtl")
  await page.evaluate(() => { document.documentElement.dir = "ltr" })
  await page.setViewportSize({ width: 1280, height: 900 })

  expect(otherWrites()).toEqual([])
  expect(fixture.unexpected).toEqual([])
  console.log(`PASS ${app ? "packaged native" : "browser"} permission rail: pinned actions over long details, collapsed details, child owner, keyboard reply, single send, error retry, draft kept, mobile RTL, no other writes`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}
