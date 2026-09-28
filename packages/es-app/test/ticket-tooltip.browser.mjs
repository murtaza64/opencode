import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.messages[1].parts[0].text = "[PR](https://github.com/example/repo/pull/71/files) and [fallback](https://github.com/example/repo/pull/72) and [issue](https://github.com/example/repo/issues/73)"
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "ticket-tip-")) : undefined
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
  await app.evaluate(({ app, shell }) => {
    app.tipOpened = []
    shell.openExternal = async url => { app.tipOpened.push(url) }
  })
}
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const state = await (await fetch(`${fixture.url}/api/state`)).json()
state.threads[0].prs = [{ repo: "example/repo", number: 71, url: "https://github.com/example/repo/pull/71", title: "Fixture PR", state: "merged" }]
await page.route("**/api/state*", async route => {
  await route.fulfill({ json: state })
})
const opened = () => app ? app.evaluate(({ app }) => app.tipOpened) : page.locator("#tip-events").evaluate(el => JSON.parse(el.textContent))
try {
  await page.goto(preview.url)
  if (!app) await page.evaluate(() => {
    const output = document.createElement("output")
    output.id = "tip-events"
    output.hidden = true
    output.textContent = "[]"
    document.body.append(output)
    for (const type of ["click", "auxclick"]) document.addEventListener(type, event => {
      const a = event.target.closest?.(".ticket-tip a[href]")
      if (!a) return
      event.preventDefault()
      output.textContent = JSON.stringify([...JSON.parse(output.textContent), a.href])
    })
  })
  for (const [label, number, action] of [["PR", 71, "click"], ["fallback", 72, "middle"], ["PR", 71, "keyboard"], ["fallback", 72, "meta"]]) {
    const source = page.locator(".transcript").getByRole("link", { name: label, exact: true })
    await source.hover()
    const tip = page.locator(".ticket-tip")
    const link = tip.locator(`a[href*="/pull/${number}"]`).first()
    await expect(link).toBeVisible()
    await link.hover()
    await expect(link).toBeVisible()
    const before = (await opened()).length
    if (action === "keyboard") { await link.focus(); await link.press("Enter") }
    else await link.click({ button: action === "middle" ? "middle" : "left", modifiers: action === "meta" ? ["Meta"] : [] })
    await expect.poll(async () => (await opened()).length).toBe(before + 1)
    expect((await opened()).at(-1)).toBe(`https://duo.fyi/ink/https://github.com/example/repo/pull/${number}`)
    await page.mouse.move(0, 0)
    await expect(tip).toHaveCount(0)
  }
  await page.locator(".transcript").getByRole("link", { name: "issue", exact: true }).hover()
  await expect(page.locator(".ticket-tip a[href*='/issues/73']")).toBeVisible()
  expect(fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log(`PASS tooltip ${app ? "native" : "browser"}: PR/fallback hover-to-link, pointer/keyboard/middle/Meta dispatch once, genuine exit, issue routing; zero mutations`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}
