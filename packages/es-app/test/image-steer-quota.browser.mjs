import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { createFixture, directory, imageCapability } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const fixture = await createFixture()
fixture.status = "busy"
fixture.images = imageCapability
process.env.OPENCODE_URL = fixture.url
process.env.ES_DASHBOARD_URL = fixture.url
const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { host: "127.0.0.1", port: 0 } })
await vite.listen()
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const page = await browser.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
try {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("quota-fixture")) return
    for (let index = 0; index < 4; index++) localStorage.setItem(`unrelated-${index}`, "x".repeat(1_000_000))
    sessionStorage.setItem("quota-fixture", "1")
  })
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  const editor = page.locator(".direct-composer textarea:visible")
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeVisible()
  const originalSize = await editor.evaluate(async (el) => {
    const canvas = document.createElement("canvas")
    canvas.width = 3000
    canvas.height = 2000
    const pixels = canvas.getContext("2d").createImageData(3000, 2000)
    for (let offset = 0; offset < pixels.data.length / 2; offset += 65536)
      crypto.getRandomValues(pixels.data.subarray(offset, Math.min(offset + 65536, pixels.data.length / 2)))
    canvas.getContext("2d").putImageData(pixels, 0, 0)
    const file = await new Promise((resolve) => canvas.toBlob((blob) => resolve(new File([blob], "noise.png", { type: "image/png" })), "image/png"))
    const data = new DataTransfer()
    data.items.add(file)
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }))
    return file.size
  })
  expect(originalSize).toBeGreaterThan(5_242_880)
  await expect(page.locator(".attachment-chip")).toHaveCount(1, { timeout: 30000 })
  await editor.fill("Screenshot for the current task")
  await page.getByRole("button", { name: "Steer", exact: true }).click()
  await expect.poll(() => fixture.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/input").length).toBe(1)
  const posts = fixture.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/input")
  expect(posts).toHaveLength(1)
  expect(posts[0].body.delivery).toBe("steer")
  expect(posts[0].body.images).toHaveLength(1)
  expect(Buffer.from(posts[0].body.images[0].url.split(",")[1], "base64").length).toBeLessThanOrEqual(5_242_880)
  await expect(page.getByText(/could not be saved|Cannot save/i)).toHaveCount(0)
  await page.reload()
  await expect(page.getByText(/images are missing|could not be restored/i)).toHaveCount(0)
  await expect(page.getByText("Pending inputs")).toBeVisible()
  await expect(page.getByText(/1 image/).first()).toBeVisible()
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  console.log("PASS image steer quota browser: large PNG, persisted admission, reload")
} finally {
  await browser.close()
  await vite.close()
  await fixture.close()
}
