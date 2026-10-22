import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { createFixture, directory, imageCapability } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const fixture = await createFixture()
fixture.status = "idle"
fixture.holdNormal = true
fixture.images = imageCapability
fixture.messages = Array.from({ length: 30 }, (_, index) => ({
  info: {
    id: `msg_${String(index).padStart(3, "0")}`,
    sessionID: "ses_a",
    role: "user",
    agent: "build",
    model: { providerID: "fixture", modelID: "test" },
    time: { created: index + 1 },
  },
  parts: [{ id: `part_${index}`, sessionID: "ses_a", messageID: `msg_${String(index).padStart(3, "0")}`, type: "text", text: `Earlier message ${index}` }],
}))
process.env.OPENCODE_URL = fixture.url
process.env.ES_DASHBOARD_URL = fixture.url
const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { host: "127.0.0.1", port: 0 } })
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const page = await browser.newPage({ viewport: { width: 900, height: 500 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
const editor = page.locator(".prompt-box:not([inert]) textarea")
const bubble = page.locator(".pending-bubble")
try {
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await expect(page.locator('[data-component="user-message"]')).toHaveCount(30)
  await expect(page.locator('.prompt-box button[aria-label="Send"]')).toBeVisible()
  await editor.fill("pending echo fixture text")
  await editor.press("Escape")
  await editor.press("Enter")
  const release = setTimeout(() => fixture.normalReplies.shift()?.(), 1500)
  try {
    await expect(bubble).toHaveText("pending echo fixture text", { timeout: 300 })
    await expect(page.locator(".pending-hint")).toHaveText("Sending…", { timeout: 300 })
    await expect.poll(() => page.locator(".transcript").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), { timeout: 1000 }).toBeLessThan(4)
    await expect.poll(() => fixture.calls.filter((call) => call.path === "/session/ses_a/prompt_async" && call.method === "POST").length).toBe(1)
    expect(fixture.calls.find((call) => call.path === "/session/ses_a/prompt_async").body.parts[0].text).toBe("pending echo fixture text")
    await expect(page.locator(".pending-hint")).toHaveText("Sent — waiting for the daemon…")
    const info = {
      id: "msg_zzz", sessionID: "ses_a", role: "user", agent: "build",
      model: { providerID: "fixture", modelID: "test" }, time: { created: Date.now() },
    }
    fixture.emit("message.updated", { info })
    fixture.emit("message.part.updated", { part: {
      id: "part_echo", sessionID: "ses_a", messageID: info.id, type: "text", text: "pending echo fixture text",
    } })
    await expect(bubble).toHaveCount(0)
    await expect(page.locator('[data-component="user-message"]').filter({ hasText: "pending echo fixture text" })).toHaveCount(1)
    await expect(page.locator(".normal-submission")).toHaveCount(0)
  } finally {
    clearTimeout(release)
  }

  // Image-only send with two images: the held echo shows both thumbnails.
  const source = await browser.newPage()
  await source.setContent('<div style="width:48px;height:32px;background:#123456">A</div>')
  const first = (await source.locator("div").screenshot()).toString("base64")
  await source.setContent('<div style="width:48px;height:32px;background:#abcdef">B</div>')
  const second = (await source.locator("div").screenshot()).toString("base64")
  await source.close()
  const paste = (images) => editor.evaluate((el, images) => {
    const data = new DataTransfer()
    for (const [name, base64] of images) data.items.add(new File([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], name, { type: "image/png" }))
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }))
  }, images)
  const removes = page.locator('.prompt-box button[aria-label^="Remove "]')
  const echoImages = page.locator(".pending-msg img")
  await editor.press("i")
  await paste([["a.png", first], ["b.png", second]])
  await expect(removes).toHaveCount(2)
  await editor.press("Escape")
  await editor.press("Enter")
  await expect(echoImages).toHaveCount(2)
  await expect(bubble).toHaveCount(0)
  expect(await echoImages.evaluateAll((images) => images.map((image) => image.getAttribute("src")))).toEqual([`data:image/png;base64,${first}`, `data:image/png;base64,${second}`])
  await expect.poll(() => fixture.calls.filter((call) => call.path === "/session/ses_a/prompt_async" && call.method === "POST").length).toBe(2)
  const imagePost = fixture.calls.filter((call) => call.path === "/session/ses_a/prompt_async").at(-1)
  expect(imagePost.body.parts.filter((part) => part.type === "file").map((part) => part.url)).toEqual([`data:image/png;base64,${first}`, `data:image/png;base64,${second}`])
  fixture.normalReplies.shift()()
  await expect(page.locator(".pending-hint")).toHaveText("Sent — waiting for the daemon…")
  await expect(echoImages).toHaveCount(2)
  await expect(removes).toHaveCount(0)
  const imageInfo = { id: "msg_zzz_images", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: Date.now() } }
  fixture.emit("message.updated", { info: imageInfo })
  for (const [index, base64] of [first, second].entries())
    fixture.emit("message.part.updated", { part: { id: `part_image_${index}`, sessionID: "ses_a", messageID: imageInfo.id, type: "file", mime: "image/png", filename: `${index}.png`, url: `data:image/png;base64,${base64}` } })
  await expect(page.locator(".pending-msg")).toHaveCount(0)
  expect(fixture.calls.filter((call) => call.path === "/session/ses_a/prompt_async" && call.method === "POST")).toHaveLength(2)

  // Lost acknowledgement: the echo and the draft both keep the exact image.
  fixture.holdNormal = false
  fixture.loseNormal = true
  await editor.press("i")
  await editor.fill("lost with image")
  await paste([["c.png", first]])
  await expect(removes).toHaveCount(1)
  await editor.press("Escape")
  await editor.press("Enter")
  await expect(page.locator(".pending-hint")).toHaveText("Send not confirmed")
  await expect(bubble).toHaveText("lost with image")
  await expect(echoImages).toHaveCount(1)
  await expect(removes).toHaveCount(1)
  expect(fixture.calls.filter((call) => call.path === "/session/ses_a/prompt_async" && call.method === "POST")).toHaveLength(3)
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  console.log("PASS pending echo browser: immediate pending, pinned transcript, accepted, SSE echo replacement, image-only and multi-image thumbnails, lost-ack image retention")
} finally {
  await browser.close()
  await vite.close()
  await fixture.close()
}
