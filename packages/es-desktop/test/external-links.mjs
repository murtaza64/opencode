import { _electron, expect } from "@playwright/test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createFixture, directory } from "../../es-app/test/composer-fixture.mjs"

export const checkExternalLinks = async (app, page, origin) => {
  // Stub only the OS boundary; clicks still run the installed native handlers.
  await app.evaluate(({ app, dialog, shell }) => {
    app.linkChecks = { dialogs: [], opened: [] }
    dialog.showMessageBox = async (_window, options) => {
      app.linkChecks.dialogs.push(options)
      return { response: 0, checkboxChecked: false }
    }
    shell.openExternal = async (url) => { app.linkChecks.opened.push(url) }
  })
  const original = page.url()
  await page.evaluate(() => {
    for (const href of ["file:///tmp/es-desktop-decoy", "ink://open", "mailto:fixture@example.com", "https://u:p@example.com/"]) {
      const link = document.createElement("a")
      link.href = href
      link.target = "_blank"
      document.body.append(link)
      link.click()
      link.remove()
    }
    const link = document.createElement("a")
    link.href = "https://example.com/review"
    link.target = "_blank"
    document.body.append(link)
    link.click()
    link.remove()
  })
  await expect.poll(() => app.evaluate(({ app }) => app.linkChecks.opened)).toEqual(["https://example.com/review"])
  await page.evaluate(() => {
    const link = document.createElement("a")
    link.href = "http://example.com/same-window"
    document.body.append(link)
    link.click()
    link.remove()
  })
  await expect.poll(() => app.evaluate(({ app }) => app.linkChecks.opened)).toEqual([
    "https://example.com/review", "http://example.com/same-window",
  ])
  expect(page.url()).toBe(original)
  expect(app.windows()).toHaveLength(1)
  // A same-origin session link continues inside the existing native window.
  await page.evaluate(href => {
    const link = document.createElement("a")
    link.href = href
    document.body.append(link)
    link.click()
  }, `${origin}/session/ses_b?directory=${encodeURIComponent(directory)}`)
  await page.waitForURL(`${origin}/session/ses_b?directory=${encodeURIComponent(directory)}`)
  await expect(page.locator(".topbar h1")).toHaveText("Other session")
  expect(await app.evaluate(({ app }) => app.linkChecks)).toEqual({
    dialogs: [], opened: ["https://example.com/review", "http://example.com/same-window"],
  })
  await page.goto(original)
  console.info("PASS native links: no confirmation, one browser dispatch per click, internal session navigation, unsupported URLs rejected")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await createFixture()
  const profile = await mkdtemp(path.join(tmpdir(), "editspace-links-"))
  const app = await _electron.launch({
    executablePath: process.env.ES_DESKTOP_EXECUTABLE,
    args: process.env.ES_DESKTOP_EXECUTABLE ? [] : [path.resolve(import.meta.dirname, "..")],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url,
      OPENCODE_SERVER_PASSWORD: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "" },
  })
  try {
    const page = await app.firstWindow()
    await page.waitForURL("http://127.0.0.1:*/")
    const origin = new URL(page.url()).origin
    await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
    await expect(page.locator(".topbar h1")).toHaveText("Composer fixture")
    await checkExternalLinks(app, page, origin)
    expect(fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  } finally {
    await app.close()
    await fixture.close()
    await rm(profile, { recursive: true, force: true })
  }
}
