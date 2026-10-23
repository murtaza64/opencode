import { createRequire } from "node:module"
import { body, longID, longName, startMailOverflowPreview } from "./mail-overflow-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startMailOverflowPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const page = await browser.newPage()
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const errors = []
page.on("pageerror", error => errors.push(error.message))

const bounded = async (label) => {
  const sizes = await page.locator("html, body, .session-page, .session-main, .transcript, .mail-activity, .mail-activity-summary, .mail-activity[open] .mail-activity-details, .mail-activity[open] .mail-activity-body, .mail-activity[open] .mail-delivery").evaluateAll(elements => elements.map(el => ({
    element: el.className || el.tagName, scroll: el.scrollWidth, client: el.clientWidth,
  })).filter(size => size.scroll > size.client))
  expect(sizes, `${label}: no horizontal scrolling at page, transcript, or mail boundaries`).toEqual([])
}

try {
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(preview.url)
    const rows = page.locator('.transcript [data-mail-id]:not([data-mail-id="reference"])')
    await expect(rows).toHaveCount(2)
    for (const [lang, dir] of [["en", "ltr"], ["en", "rtl"], ["ar", "rtl"]]) {
      const label = `${width}px ${lang}/${dir}`
      await page.evaluate(({ lang, dir }) => {
        document.documentElement.lang = lang
        document.documentElement.dir = dir
      }, { lang, dir })
      await bounded(`${label} collapsed`)
      for (const row of await rows.all()) {
        const summary = row.locator("summary")
        await expect(summary).toContainText("queued")
        await expect(summary).toContainText("handled")
        // Each route party truncates on its own, so both ends stay visible.
        for (const selector of [".mail-activity-route .mail-party >> nth=0", ".mail-activity-route .mail-party >> nth=1", ".mail-activity-state"]) {
          const size = await row.locator(selector).evaluate(el => ({
            client: el.clientWidth, scroll: el.scrollWidth,
            ellipsis: getComputedStyle(el).textOverflow, overflow: getComputedStyle(el).overflowX,
            nowrap: getComputedStyle(el).whiteSpace,
          }))
          expect(size.client, `${label} ${selector} has visible space`).toBeGreaterThan(0)
          expect(size.scroll, `${label} ${selector} stress text is truncated`).toBeGreaterThan(size.client)
          expect(size).toMatchObject({ ellipsis: "ellipsis", overflow: "hidden", nowrap: "nowrap" })
        }
        await summary.click()
        await expect(row).toHaveAttribute("open", "")
        await expect(row.locator(".mail-activity-body")).toHaveText(body)
        await expect(row.locator(".mail-activity-details")).toContainText(`From: ${longName}`)
        await expect(row.locator(".mail-activity-details")).toContainText(`To: ${longName}-recipient`)
        await expect(row.locator(".mail-activity-details")).toContainText(`Origin run: ${longID}`)
        await expect(row.locator(".mail-delivery")).toHaveCount(160)
        await expect(row.locator(".mail-delivery").last()).toContainText(`${longID}-159`)
        await bounded(`${label} expanded`)
        await row.locator(".mail-delivery").last().scrollIntoViewIfNeeded()
        await expect(row.locator(".mail-delivery").last()).toBeInViewport()
        // Full route and provenance stay selectable, and native keyboard disclosure still works.
        await summary.focus()
        await page.keyboard.press("Enter")
        await expect(row).not.toHaveAttribute("open", "")
        await summary.focus()
        await page.keyboard.press("Space")
        await expect(row).toHaveAttribute("open", "")
        await row.locator('a[href="#mail-reference"]').click()
        await expect(page).toHaveURL(/#mail-reference$/)
        await page.locator('[id="mail-reference"]').scrollIntoViewIfNeeded()
        await expect(page.locator('[id="mail-reference"]')).toBeInViewport()
        await summary.click()
        await expect(row).not.toHaveAttribute("open", "")
      }
      await expect(page.locator('.transcript [data-component="user-message-text"], .transcript [data-slot="user-message-text"]')).toContainText(["Review the composer"])
      await expect(page.locator('.transcript [data-component="text-part"]')).toContainText(["isolated UI preview"])
      await bounded(`${label} closed again`)
      console.log(`PASS mail overflow ${label}: collapsed/expanded, 160 receipts, complete details, keyboard and reference navigation`)
    }
  }
  expect(errors).toEqual([])
  expect(preview.fixture.calls.filter(call => call.method !== "GET")).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}
