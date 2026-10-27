import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { createFixture, directory, imageCapability } from "./composer-fixture.mjs"
import { warmVite } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const fixture = await createFixture()
fixture.status = "busy"
fixture.images = imageCapability
process.env.OPENCODE_URL = fixture.url
process.env.ES_DASHBOARD_URL = fixture.url
const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { host: "127.0.0.1", port: 0 } })
await vite.listen()
await warmVite(`http://127.0.0.1:${vite.httpServer.address().port}`, fixture)
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const page = await browser.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
try {
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  const editor = page.locator(".direct-composer textarea:visible")
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeVisible()
  const originals = await editor.evaluate(async (el) => {
    const paste = async (file) => {
      const url = await new Promise((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.readAsDataURL(file)
      })
      const data = new DataTransfer()
      data.items.add(file)
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }))
      return url
    }
    const wide = document.createElement("canvas")
    wide.width = 9000
    wide.height = 2000
    const wideFile = await new Promise((resolve) => wide.toBlob((blob) => resolve(new File([blob], "wide.png", { type: "image/png" })), "image/png"))
    const wideURL = await paste(wideFile)
    const noisy = document.createElement("canvas")
    noisy.width = 2500
    noisy.height = 2500
    const pixels = noisy.getContext("2d").createImageData(2500, 2500)
    // crypto.getRandomValues is limited to 65536 bytes per invocation.
    for (let offset = 0; offset < pixels.data.length / 2; offset += 65536) crypto.getRandomValues(pixels.data.subarray(offset, Math.min(offset + 65536, pixels.data.length / 2)))
    noisy.getContext("2d").putImageData(pixels, 0, 0)
    const noisyFile = await new Promise((resolve) => noisy.toBlob((blob) => resolve(new File([blob], "noise.png", { type: "image/png" })), "image/png"))
    if (noisyFile.size <= 5_242_880) throw new Error(`Noisy fixture did not exceed cap: ${noisyFile.size}`)
    const noisyURL = await paste(noisyFile)
    const small = document.createElement("canvas")
    small.width = 64
    small.height = 64
    const smallFile = await new Promise((resolve) => small.toBlob((blob) => resolve(new File([blob], "small.png", { type: "image/png" })), "image/png"))
    const smallURL = await paste(smallFile)
    return { wideURL, noisyURL, smallURL, noisyBytes: noisyFile.size }
  })
  await expect(page.locator(".attachment-chip")).toHaveCount(3, { timeout: 30000 })
  await expect(page.locator('.attachment-chip[data-normalized="true"]')).toHaveCount(2)
  await expect(page.locator('.attachment-chip[data-normalized="true"]').first()).toHaveAttribute("title", /resized to fit/)
  await editor.fill("Screenshot for the current task")
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Steer", exact: true }).click()
  await expect.poll(() => fixture.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/input").length).toBe(1)
  const posts = fixture.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/input")
  expect(posts).toHaveLength(1)
  expect(posts[0].body.delivery).toBe("steer")
  const images = posts[0].body.images
  expect(images).toHaveLength(3)
  expect(images.map((image) => image.mime).every((mime) => ["image/png", "image/jpeg"].includes(mime))).toBe(true)
  const sizes = images.map((image) => Buffer.from(image.url.split(",")[1], "base64").length)
  expect(sizes.every((bytes) => bytes <= 5_242_880)).toBe(true)
  expect(sizes.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(10_485_760)
  expect(images[2].url).toBe(originals.smallURL)
  const wideDimensions = await page.evaluate(async (url) => {
    const image = new Image()
    image.src = url
    await image.decode()
    return { width: image.naturalWidth, height: image.naturalHeight }
  }, images[0].url)
  expect(wideDimensions.width).toBeLessThanOrEqual(8192)
  const before = page.locator(".attachment-chip")
  const count = await before.count()
  await editor.evaluate((el) => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array([1, 2, 3])], "x.tiff", { type: "image/tiff" }))
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }))
  })
  await expect(page.locator('.direct-feedback.err[role="alert"]')).toContainText("image/tiff")
  await expect(before).toHaveCount(count)
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  console.log("PASS image input browser: dimensions, byte budgets, original bytes, decode error")
} finally {
  await browser.close()
  await vite.close()
  await fixture.close()
}
