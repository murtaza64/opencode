// Agent-shared links to es-app routes (published web 3181, dev 3100, native 60302, this origin, relative)
// navigate in place without a reload or new window; other destinations keep their external behavior.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const target = `/session/ses_b?directory=${encodeURIComponent(directory)}`
const preview = await startPanelPreview()
const fixture = preview.fixture
const internal = [
  { label: "Published web session", href: `http://127.0.0.1:3181${target}` },
  { label: "Relative session", href: target },
  { label: "Native port session", href: `http://127.0.0.1:60302${target}` },
  // Old /desk links redirect in place to the Front desk at "/".
  { label: "Dev desk", href: "http://localhost:3100/desk", path: "/" },
]
const external = [
  { label: "External site", href: "https://example.com/session/ses_b" },
  { label: "Other loopback app", href: "http://127.0.0.1:64297/map" },
]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext()
const page = await context.newPage()
const popups = []
context.on("page", (opened) => popups.push(opened.url()))
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const home = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
const open = async () => {
  await page.goto(home)
  await page.evaluate(() => { window.appLinkMarker = "same-document" })
}
try {
  for (const item of internal) {
    fixture.messages[1].parts[0].text = `[${item.label}](${item.href})\n\n[${preview.origin} self](${preview.origin}${target})`
    await open()
    await page.locator(".transcript").getByRole("link", { name: item.label, exact: true }).click()
    await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(item.path ?? target)
    expect(new URL(page.url()).origin).toBe(preview.origin)
    expect(await page.evaluate(() => window.appLinkMarker)).toBe("same-document")
  }
  await open()
  await page.locator(".transcript").getByRole("link", { name: `${preview.origin} self`, exact: true }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe("/session/ses_b")
  expect(await page.evaluate(() => window.appLinkMarker)).toBe("same-document")

  for (const item of external) {
    fixture.messages[1].parts[0].text = `[${item.label}](${item.href})`
    await open()
    // Record default handling instead of leaving the fixture: an unhandled external click is not prevented.
    await page.evaluate(() => {
      window.externalClicks = []
      document.addEventListener("click", (event) => {
        const anchor = event.target.closest?.("a[href]")
        if (!anchor) return
        window.externalClicks.push({ href: anchor.href, prevented: event.defaultPrevented })
        event.preventDefault()
      })
    })
    await page.locator(".transcript").getByRole("link", { name: item.label, exact: true }).click()
    expect(await page.evaluate(() => window.externalClicks)).toEqual([{ href: item.href, prevented: false }])
    expect(page.url()).toBe(home)
  }
  expect(popups).toEqual([])
  // The operator-session bootstrap is the only write the page itself issues.
  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method) && call.path !== "/api/attention/session")).toEqual([])
  expect(errors).toEqual([])
  console.log("PASS app links: published-web/native/dev/self/relative session links navigate in place (no reload, no window); external and non-app loopback links untouched; no data writes")
} finally {
  await browser.close()
  await preview.close()
}
