// Inline images in user messages (CHAT-PARTS §3): each image keeps one box from Sending through
// Sent to the transcript echo, sized from the image header before decode; click/Enter enlarges.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")

const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.addInitScript(() => {
  window.__shifts = []
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__shifts.push(entry.value) })
    .observe({ type: "layout-shift", buffered: true })
})
const editor = page.getByRole("textbox", { name: "Message", exact: true })
const posts = () => fixture.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/prompt_async")
const boxes = (locator) => locator.evaluateAll((elements) => elements.map((element) => {
  const rect = element.getBoundingClientRect()
  return { x: Math.round(rect.x * 10) / 10, w: Math.round(rect.width * 10) / 10, h: Math.round(rect.height * 10) / 10 }
}))
// Pixel images of a known size, as the clipboard would carry them.
const shot = async (width, height, color) => {
  const source = await browser.newPage({ viewport: { width: Math.max(width, 100), height: Math.max(height, 100) } })
  await source.setContent(`<div style="width:${width}px;height:${height}px;background:${color}"></div>`)
  const base64 = (await source.locator("div").screenshot()).toString("base64")
  await source.close()
  return base64
}

const send = async (label, text, images, expected) => {
  await page.evaluate(() => { window.__shifts = [] })
  const before = posts().length
  await editor.fill(text)
  await editor.evaluate((element, images) => {
    const data = new DataTransfer()
    images.forEach((base64, index) => data.items.add(new File([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], `shot-${index}.png`, { type: "image/png" })))
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }))
  }, images)
  await expect(page.locator('.prompt-box button[aria-label^="Remove "]')).toHaveCount(images.length)
  fixture.holdNormal = true
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.locator(".pending-hint").last()).toHaveText("Sending…")
  const pending = page.locator(".pending-msg .chat-image")
  await expect(pending).toHaveCount(expected.shown)
  // The box is reserved from the header before any decode: measure immediately.
  const sending = await boxes(pending)
  await expect(page.locator(".pending-msg .pending-bubble"), `${label}: image-only has no empty text box`).toHaveCount(text ? 1 : 0)
  fixture.holdNormal = false
  fixture.normalReplies.splice(0).forEach((reply) => reply())
  await expect(page.locator(".pending-hint").last()).toHaveText("Sent")
  const sent = await boxes(pending)
  const body = posts().at(-1).body
  expect(posts().length, `${label}: one admission`).toBe(before + 1)
  const info = { id: body.messageID, sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: Date.now() } }
  fixture.emit("message.updated", { info })
  body.parts.forEach((part, index) =>
    fixture.emit("message.part.updated", { part: { ...part, id: `prt_${info.id}_${index}`, sessionID: "ses_a", messageID: info.id } }))
  await expect(page.locator(".pending-msg")).toHaveCount(0)
  const echoedImages = page.locator(".msg-wrap").last().locator(".chat-image")
  await expect(echoedImages).toHaveCount(expected.shown)
  const echoed = await boxes(echoedImages)
  const cls = await page.evaluate(() => window.__shifts.reduce((sum, value) => sum + value, 0))
  console.log("GEOM", label, JSON.stringify({ sending, sent, echoed, cls: Math.round(cls * 10000) / 10000 }))
  expect(sent, `${label}: Sending -> Sent keeps every image box`).toEqual(sending)
  expect(echoed.map(({ w, h }) => ({ w, h })), `${label}: echo keeps every image size`).toEqual(sending.map(({ w, h }) => ({ w, h })))
  expect(echoed.map(({ x }) => x), `${label}: echo keeps every image position`).toEqual(sending.map(({ x }) => x))
  sending.forEach((box) => expected.size(box, label))
  expect(cls, `${label}: no layout shift`).toBeLessThan(0.01)
  await expect(page.locator(".msg-wrap").last().locator(".chat-image-more")).toHaveCount(expected.more ? 1 : 0)
  return echoedImages
}

try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.locator(".session-work-status:visible")).toHaveAttribute("data-state", "idle")
  const wide = await shot(800, 450, "#3a6ea5")
  const tall = await shot(300, 600, "#a5603a")
  const small = await shot(120, 80, "#3aa560")

  // Text + screenshot: natural aspect within 360x280.
  const echoed = await send("text+screenshot", "the buttons on this surface do nothing", [wide], {
    shown: 1, size: (box, label) => { expect(box.w, label).toBe(360); expect(Math.abs(box.h - 202.5), label).toBeLessThan(1) },
  })
  // Click enlarges in a modal; Esc closes; Enter from the keyboard opens it again.
  await echoed.first().click()
  const viewer = page.getByRole("dialog", { name: "Image viewer" })
  await expect(viewer).toBeVisible()
  await expect(viewer.getByRole("img")).toHaveAttribute("alt", "shot-0.png")
  await page.keyboard.press("Escape")
  await expect(viewer).toBeHidden()
  await echoed.first().focus()
  await page.keyboard.press("Enter")
  await expect(viewer).toBeVisible()
  await page.keyboard.press("Escape")

  await send("image-only tall", "", [tall], {
    shown: 1, size: (box, label) => { expect(box.h, label).toBe(280); expect(box.w, label).toBe(140) },
  })
  const four = await send("four images", "four", [wide, tall, small, wide], {
    shown: 4, size: (box, label) => expect(box.h, label).toBeLessThanOrEqual(160),
  })
  // Natural aspect at most 160 px tall; a small image is never stretched or upscaled.
  expect((await boxes(four)).map(({ w, h }) => [Math.round(w), Math.round(h)])).toEqual([[284, 160], [80, 160], [120, 80], [284, 160]])
  await send("six images", "", [wide, tall, small, wide, tall, small], {
    shown: 3, more: true, size: (box, label) => expect(box.h, label).toBeLessThanOrEqual(160),
  })
  await expect(page.locator(".msg-wrap").last().locator(".chat-image-more")).toHaveText("+3")

  // Narrow RTL: images sit on the person's side (inline end = left) and fit the column.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { document.documentElement.lang = "ar"; document.documentElement.dir = "rtl" })
  const rtl = await send("narrow rtl", "نص مع صورة", [wide], {
    shown: 1, size: (box, label) => expect(box.w, label).toBeLessThanOrEqual(360),
  })
  const [image, column] = await Promise.all([rtl.first().boundingBox(), page.locator(".msg-wrap").last().boundingBox()])
  expect(Math.abs(image.x - column.x), "RTL: image hugs the inline-end (left) edge").toBeLessThan(column.width * 0.2)

  expect(fixture.calls.filter((call) => call.method !== "GET" && call.path !== "/session/ses_a/prompt_async"), "no other writes").toEqual([])
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  console.log("PASS chat images: one box Sending -> Sent -> echo for text+image, image-only, four, +N, narrow RTL; click/Enter enlarge, Esc closes; one admission each; CLS < 0.01")
} finally {
  await browser.close()
  await preview.close()
}
