// DESKTOP_BINARY and FIXTURE_TEST_DIR identify the installed app and its matching fixture sources.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const fixtureDir = process.env.FIXTURE_TEST_DIR
const { createFixture, directory } = await import(pathToFileURL(path.join(fixtureDir, "composer-fixture.mjs")))
const { _electron } = createRequire(path.join(fixtureDir, "../../app/package.json"))("@playwright/test")
const fixture = await createFixture()
fixture.setStatus("idle")
fixture.permissions = []
fixture.holdNormal = true
const profile = await mkdtemp(path.join(tmpdir(), "desktop-echo-"))
let app
try {
  app = await _electron.launch({ executablePath: process.env.DESKTOP_BINARY, args: ["--use-mock-keychain"], env: {
    PATH: process.env.PATH, HOME: profile, ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden",
    OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url,
  } })
  const page = await app.firstWindow()
  await page.waitForURL("http://127.0.0.1:*/")
  const origin = new URL(page.url()).origin
  assert.notEqual(new URL(origin).port, "60302")
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  const text = "Synthetic echo timing"
  await editor.fill(text)
  await page.getByRole("button", { name: "Send", exact: true }).waitFor()
  await page.evaluate(text => {
    const marks = window.echoMarks = {}
    window.addEventListener("keydown", event => { if (event.key === "Enter") marks.enter = performance.now() }, { capture: true })
    const fetch = window.fetch
    window.fetch = async (...args) => {
      const tracked = String(args[0]).includes("/prompt_async")
      if (tracked) marks.dispatch = performance.now()
      const response = await fetch(...args)
      if (tracked) marks.ack = performance.now()
      return response
    }
    const observer = new MutationObserver(() => {
      if (!marks.enter || marks.echo || !document.querySelector('[aria-label="Message status"]')?.textContent.includes(text)) return
      marks.echo = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => { marks.frame = performance.now() }))
      observer.disconnect()
    })
    observer.observe(document.body, { childList: true, characterData: true, subtree: true })
  }, text)
  await editor.press("Control+Enter")
  await page.waitForFunction(() => window.echoMarks.frame)
  const before = await page.evaluate(() => window.echoMarks)
  assert.equal(before.ack, undefined, "Local echo must appear before the held acknowledgment")
  assert.equal(fixture.normalReplies.length, 1)
  await new Promise(resolve => setTimeout(resolve, 2000))
  fixture.normalReplies.shift()()
  await page.waitForFunction(() => window.echoMarks.ack)
  const marks = await page.evaluate(() => window.echoMarks)
  console.log(JSON.stringify(Object.fromEntries(Object.entries(marks).map(([key, at]) => [key, Math.round(at - marks.enter)]))))
} finally { await app?.close(); await fixture.close(); await rm(profile, { recursive: true, force: true }) }
