import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const cases = [
  { label: "Issue", url: "https://github.com/owner/repo/issues/7?x=%2f#comment", expected: "https://github.com/owner/repo/issues/7?x=%2f#comment", action: "click" },
  { label: "PR files", url: "https://github.com/owner/repo/pull/7/files?diff=split#review", expected: "https://duo.fyi/ink/https://github.com/owner/repo/pull/7/files?diff=split#review", action: "Enter" },
  { label: "Wrapped issue", url: "https://duo.fyi/ink/https://github.com/owner/repo/issues/8#comment", expected: "https://github.com/owner/repo/issues/8#comment", action: "middle" },
  { label: "Repository", url: "https://github.com/owner/repo?tab=readme#top", expected: "https://github.com/owner/repo?tab=readme#top", action: "Meta" },
  { label: "Wrapped PR", url: "https://duo.fyi/ink/https://github.com/owner/repo/pull/8?x=1#top", expected: "https://duo.fyi/ink/https://github.com/owner/repo/pull/8?x=1#top", action: "click" },
  { label: "Commit", url: "https://github.com/owner/repo/commit/abc", expected: "https://github.com/owner/repo/commit/abc", action: "middle" },
  { label: "Invalid PR suffix", url: "https://github.com/owner/repo/pull/8abc", expected: "https://github.com/owner/repo/pull/8abc", action: "Enter" },
  { label: "Lookalike", url: "https://github.com.example.org/owner/repo/pull/8", expected: "https://github.com.example.org/owner/repo/pull/8", action: "click" },
]
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.messages[1].parts[0].text = cases.map(item => `[${item.label}](${item.url})`).join("\n\n")
fixture.issue = { backend: "gh", number: 1, ref: "1", title: "Routing fixture", state: "open", markers: [], claims: [], labels: [], comments: [],
  url: "https://duo.fyi/ink/https://github.com/owner/repo/issues/1?x=1#body", body: "Read-only issue fixture" }
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "link-routing-")) : undefined
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
  await app.evaluate(({ app, dialog, shell }) => {
    app.routingChecks = { opened: [], dialogs: 0 }
    shell.openExternal = async url => { app.routingChecks.opened.push(url) }
    dialog.showMessageBox = async () => { app.routingChecks.dialogs++; return { response: 0, checkboxChecked: false } }
  })
}
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const errors = []
page.on("pageerror", error => errors.push(error.message))
const opened = () => app ? app.evaluate(({ app }) => app.routingChecks.opened) : page.locator("#routing-events").evaluate(el => JSON.parse(el.textContent))
const recordBrowserLinks = async () => {
  if (app) return
  await page.evaluate(() => {
    const output = document.createElement("output")
    output.id = "routing-events"
    output.hidden = true
    output.textContent = "[]"
    document.body.append(output)
    const record = event => {
      const anchor = event.target.closest?.("a[href]")
      if (!anchor || new URL(anchor.href).origin === location.origin) return
      event.preventDefault()
      output.textContent = JSON.stringify([...JSON.parse(output.textContent), anchor.href])
    }
    document.addEventListener("click", record)
    document.addEventListener("auxclick", record)
  })
}
try {
  await page.goto(preview.url)
  await recordBrowserLinks()
  const expected = []
  for (const item of cases) {
    await page.mouse.move(0, 0)
    await expect(page.locator(".ticket-tip")).toHaveCount(0)
    const link = page.locator(".transcript").getByRole("link", { name: item.label, exact: true })
    if (item.action === "Enter") { await link.focus(); await link.press("Enter") }
    else await link.click({ button: item.action === "middle" ? "middle" : "left", modifiers: item.action === "Meta" ? ["Meta"] : [] })
    expected.push(item.expected)
    await expect.poll(opened).toEqual(expected)
    await expect(link).toHaveAttribute("href", item.expected)
    expect(page.url()).toBe(preview.url)
  }
  // IssuePage's component-level linkUrl call unwraps before any delegated event.
  await page.goto(`${preview.origin}/issue?ref=1`)
  await recordBrowserLinks()
  const issueLink = page.getByRole("link", { name: "open on github ↗", exact: true })
  await expect(issueLink).toHaveAttribute("href", "https://github.com/owner/repo/issues/1?x=1#body")
  await issueLink.click()
  await expect.poll(opened).toEqual([...(app ? expected : []), "https://github.com/owner/repo/issues/1?x=1#body"])
  if (app) expect(await app.evaluate(({ app }) => app.routingChecks.dialogs)).toBe(0)
  expect(fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  console.log(`PASS ${app ? "packaged native dispatch (OS boundary stubbed)" : "browser rendered anchors"}: strict PR routing, wrapped non-PR normalization, idempotence, query/fragment, keyboard/middle/Meta click and component issue link; zero mutations`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}
