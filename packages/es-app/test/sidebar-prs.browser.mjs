import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.messages[1].parts[0].text = [
  ...Array.from({ length: 31 }, (_, index) => `https://github.com/example/repo/pull/${index + 1}`),
  "[duplicate](https://github.com/EXAMPLE/REPO/pull/1/files?diff=split#top)",
  "https://duo.fyi/ink/https://github.com/example/repo/pull/2?tab=files#review",
  "https://github.com/example/repo/issues/900 https://github.com.evil.test/example/repo/pull/901",
  "https://github.com/example/repo/pull/902bad",
].join("\n\n")
fixture.messages[1].parts.push({ id: "tool_prs", messageID: "msg_2", sessionID: "ses_a", type: "tool", tool: "read", callID: "read_prs",
  state: { status: "completed", input: {}, output: "Result: https://github.com/tools/output/pull/42#discussion", title: "Read", time: { start: 1, end: 2 } } })
fixture.messagesB = [{ info: { ...fixture.messages[0].info, id: "other", sessionID: "ses_b" }, parts: [
  { ...fixture.messages[0].parts[0], id: "other_part", messageID: "other", sessionID: "ses_b", text: "https://github.com/other/repo/pull/999" },
] }]
const state = await (await fetch(`${fixture.url}/api/state`)).json()
state.threads[0].prs = [{ repo: "example/repo", number: 1, url: "https://github.com/example/repo/pull/1", title: "Merged PR", state: "merged" },
  { repo: "example/repo", number: 2, url: "https://github.com/example/repo/pull/2", title: "Closed PR", state: "closed" }]
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "sidebar-prs-")) : undefined
const app = profile ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" },
}) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const page = app ? await app.firstWindow() : await browser.newPage()
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
await page.route("**/api/state*", route => route.fulfill({ json: state }))
const chips = page.locator(".session-info .pr-title-row")
try {
  await page.goto(preview.url)
  await expect(chips).toHaveCount(32)
  await expect(page.locator(".info-heading", { hasText: "PRs referenced" })).toHaveCount(1)
  await expect(chips.nth(0)).toHaveAttribute("href", "https://duo.fyi/ink/https://github.com/example/repo/pull/1")
  await expect(chips.nth(0).locator(".icon-merged")).toHaveCount(1)
  await expect(chips.nth(1).locator(".icon-closed")).toHaveCount(1)
  await expect(chips.nth(2).locator(".pr-icon")).toHaveCount(0)
  await expect(chips.nth(31)).toHaveAttribute("href", "https://duo.fyi/ink/https://github.com/tools/output/pull/42")
  await expect(page.locator(".session-info .pr-title-row[href*='/999'], .session-info .pr-title-row[href*='/900'], .session-info .pr-title-row[href*='/901'], .session-info .pr-title-row[href*='/902']")).toHaveCount(0)
  await page.reload()
  await expect(chips).toHaveCount(32)
  const info = { ...fixture.messages[0].info, id: "live_pr", sessionID: "ses_a" }
  const part = { ...fixture.messages[0].parts[0], id: "live_part", messageID: info.id, text: "https://github.com/live/repo/pull/43" }
  fixture.messages.push({ info, parts: [part] })
  fixture.emit("message.updated", { info })
  fixture.emit("message.part.updated", { part })
  await expect(chips).toHaveCount(33)
  await expect(chips.filter({ hasText: "live/repo#43" })).toHaveAttribute("href", "https://duo.fyi/ink/https://github.com/live/repo/pull/43")
  expect(fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log(`PASS sidebar PRs ${app ? "native" : "browser"}: >25, metadata/unknown, tool output, strict links, other session, reload, live addition; zero mutations`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}
