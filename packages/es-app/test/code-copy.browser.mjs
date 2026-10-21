import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
// fixture.test resolves to loopback but is not a secure context, so navigator.clipboard is absent there.
const insecureHost = "fixture.test"
const preview = await startPanelPreview([{ name: "insecure-host", config: () => ({ server: { allowedHosts: [insecureHost] } }) }])
const insecure = new URL(preview.url)
insecure.hostname = insecureHost
const source = "first line\n  indented <b>raw</b> & \"quoted\"\n\n\ttab line\nlast line"
preview.fixture.messages[1].parts[0].text = "Run this:\n\n```bash\n" + source + "\n```\n\nThen this:\n\n```\nsecond block\n```"

// Headless Chrome keeps its own in-memory clipboard; the user's system clipboard is never read or written.
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [`--host-resolver-rules=MAP ${insecureHost} 127.0.0.1`, "--disable-features=HttpsUpgrades"],
})
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: preview.origin })
await context.route("**/*", route => [preview.origin, insecure.origin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort())
const reader = await context.newPage()
await reader.goto(`${preview.origin}/`, { waitUntil: "domcontentloaded" })
const clipboard = () => reader.evaluate(() => navigator.clipboard.readText())
const resetClipboard = () => reader.evaluate(() => navigator.clipboard.writeText("sentinel"))
const page = await context.newPage()
const errors = []
page.on("pageerror", error => errors.push(error.message))

try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  const blocks = page.locator('[data-component="markdown-code"]')
  await expect(blocks).toHaveCount(2)
  await expect(blocks.first().locator('[data-slot="markdown-copy-button"]')).toHaveCount(1)
  for (const attempt of [1, 2, 3]) {
    await resetClipboard()
    await blocks.first().hover()
    await blocks.first().locator('[data-slot="markdown-copy-button"] button').click()
    await expect.poll(clipboard, { message: `secure copy attempt ${attempt}` }).toBe(source)
    await expect(blocks.first().getByRole("button", { name: "Copied" })).toBeVisible()
  }
  await blocks.nth(1).hover()
  await blocks.nth(1).getByRole("button", { name: "Copy" }).click()
  await expect.poll(clipboard).toBe("second block")
  await expect(blocks.first().getByRole("button", { name: "Copy" })).toBeVisible({ timeout: 4000 })
  console.log("PASS secure context: exact raw source incl. blank/tab lines, repeated clicks, per-block content, Copied resets")

  await page.goto(insecure.href, { waitUntil: "domcontentloaded" })
  expect(await page.evaluate(() => [window.isSecureContext, "clipboard" in navigator])).toEqual([false, false])
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  await editor.fill("Parent draft remains unchanged")
  await editor.evaluate(el => el.setSelectionRange(2, 7))
  const transcript = page.locator(".session-page .transcript")
  const scroll = await transcript.evaluate(el => el.scrollTop)
  for (const attempt of [1, 2]) {
    await resetClipboard()
    await blocks.first().hover()
    await blocks.first().locator('[data-slot="markdown-copy-button"] button').click()
    await expect.poll(clipboard, { message: `insecure copy attempt ${attempt}` }).toBe(source)
    await expect(blocks.first().getByRole("button", { name: "Copied" })).toBeFocused()
  }
  await expect(page.locator('[data-component="markdown-code"] textarea')).toHaveCount(0)
  expect(await transcript.evaluate(el => el.scrollTop)).toBe(scroll)
  await editor.focus()
  expect(await editor.evaluate(el => [el.value, el.selectionStart, el.selectionEnd])).toEqual(["Parent draft remains unchanged", 2, 7])
  // A reader's transcript selection survives the fallback borrowing the document selection.
  const prose = page.getByText("Then this:", { exact: true })
  await prose.evaluate(el => document.getSelection().selectAllChildren(el))
  await blocks.first().locator('[data-slot="markdown-copy-button"]').evaluate(host => host.querySelector("button").click())
  await expect.poll(clipboard).toBe(source)
  expect(await page.evaluate(() => document.getSelection().toString())).toBe("Then this:")
  console.log("PASS insecure context: selection fallback copies exact source; focus, scroll, composer draft/caret, page selection kept; no helper")

  await resetClipboard()
  await page.evaluate(() => { document.execCommand = () => false })
  await blocks.nth(1).hover()
  await blocks.nth(1).getByRole("button", { name: "Copy" }).click()
  await expect(blocks.nth(1).getByRole("button", { name: "Failed" })).toBeFocused()
  await expect(blocks.nth(1).locator('[data-slot="markdown-copy-button"]')).toHaveAttribute("data-copied", "failed")
  expect(await clipboard()).toBe("sentinel")
  await expect(blocks.nth(1).getByRole("button", { name: "Copy" })).toBeVisible({ timeout: 4000 })
  await page.evaluate(() => { document.execCommand = () => { throw new Error("copy command unavailable") } })
  await blocks.first().hover()
  await blocks.first().locator('[data-slot="markdown-copy-button"] button').click()
  await expect(blocks.first().getByRole("button", { name: "Failed" })).toBeFocused()
  await expect(page.locator('[data-component="markdown-code"] textarea')).toHaveCount(0)
  expect(await clipboard()).toBe("sentinel")
  console.log("PASS failure: refused or throwing copy command -> Failed feedback, focus kept, helper removed, clipboard untouched, resets to Copy")
  expect(errors).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}
