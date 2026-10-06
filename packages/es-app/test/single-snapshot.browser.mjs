import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const baseline = process.argv.includes("--baseline")
const native = !!process.env.ES_DESKTOP_EXECUTABLE
if (baseline && native) throw new Error("The baseline override runs only in the dev browser")
const root = fileURLToPath(new URL("../../..", import.meta.url))
const prior = baseline ? execFileSync("jj", ["file", "show", "-r", "849a6b4238ff", "packages/es-app/src/live-session.ts"],
  { cwd: root, encoding: "utf8" }) : undefined
const preview = await startPanelPreview(prior ? [{ name: "baseline-snapshot", enforce: "pre",
  transform(_code, id) { return id.endsWith("/src/live-session.ts") ? prior : undefined } }] : [])
const fixture = preview.fixture
fixture.messages = Array.from({ length: 12 }, (_, index) => ({
  info: { id: `msg_${String(index).padStart(6, "0")}`, sessionID: "ses_a", role: "user", agent: "build",
    model: { providerID: "fixture", modelID: "test" }, time: { created: index + 1 } },
  parts: [{ id: `prt_${index}`, messageID: `msg_${String(index).padStart(6, "0")}`, sessionID: "ses_a", type: "text",
    text: `${index}: ${"synthetic transcript text ".repeat(7000)} ${index === 11 ? "LATEST-SENTINEL" : ""}` }],
}))
fixture.messagesB = [{ info: { id: "msg_b", sessionID: "ses_b", role: "user", agent: "build",
  model: { providerID: "fixture", modelID: "test" }, time: { created: 1 } },
  parts: [{ id: "prt_b", messageID: "msg_b", sessionID: "ses_b", type: "text", text: "SECOND-SESSION-SENTINEL" }] }]
const profile = native ? await mkdtemp(path.join(tmpdir(), "single-snapshot-native-")) : undefined
const app = native ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" } }) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const page = app ? await app.firstWindow() : await browser.newPage()
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
const reads = () => fixture.calls.filter((call) => call.method === "GET" && call.path === "/session/ses_a/message").length
try {
  await page.goto(`${preview.origin}/session/ses_b?directory=${encodeURIComponent(directory)}`)
  await expect(page.locator(".transcript")).toContainText("SECOND-SESSION-SENTINEL")
  const started = Date.now()
  await page.locator('.sidebar a[href*="/session/ses_a"]').first().click()
  await expect(page.locator(".transcript")).toContainText("LATEST-SENTINEL", { timeout: 30_000 })
  await page.waitForTimeout(1000)
  const first = reads()
  const painted = Date.now() - started
  const bytes = Buffer.byteLength(JSON.stringify(fixture.messages))
  console.log(JSON.stringify({ phase: "initial", mode: native ? "packaged-native" : "browser", baseline,
    messages_get: first, response_bytes: bytes, estimated_message_bytes: bytes * first, paint_check_ms: painted }))
  expect(first).toBe(1)

  fixture.disconnect()
  fixture.messages.at(-1).parts[0].text += "\nRECOVERED-SENTINEL"
  await expect.poll(reads, { timeout: 20_000 }).toBe(2)
  await expect(page.locator(".transcript")).toContainText("RECOVERED-SENTINEL")
  await page.waitForTimeout(1200)
  expect(reads()).toBe(2)
  console.log(JSON.stringify({ phase: "reconnected", mode: native ? "packaged-native" : "browser", added_message_get: reads() - first }))

  fixture.holdMessages.set("ses_a", true)
  await page.locator('.sidebar a[href*="/session/ses_b"]').first().click()
  await expect(page.locator(".transcript")).toContainText("SECOND-SESSION-SENTINEL")
  await page.locator('.sidebar a[href*="/session/ses_a"]').first().click()
  await expect.poll(() => fixture.messageReplies.length).toBe(1)
  await page.locator('.sidebar a[href*="/session/ses_b"]').first().click()
  await expect(page.locator(".transcript")).toContainText("SECOND-SESSION-SENTINEL")
  fixture.messageReplies.splice(0).forEach((release) => release())
  await expect.poll(() => fixture.abortedMessages).toContain("ses_a")
  await expect(page.locator(".transcript")).not.toContainText("LATEST-SENTINEL")
  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log(JSON.stringify({ phase: "switch", mode: native ? "packaged-native" : "browser", stale_aborted: true, writes: 0 }))
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}
