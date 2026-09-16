import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { createFixture, directory, imageCapability } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const fixture = await createFixture()
fixture.images = imageCapability
process.env.OPENCODE_URL = fixture.url
process.env.ES_DASHBOARD_URL = fixture.url
const vite = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
})
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const errors = []
await context.route("**/*", (route) => {
  const url = new URL(route.request().url())
  if (url.origin === origin || url.protocol === "data:" || url.protocol === "blob:") return route.continue()
  errors.push(`External request: ${url.origin}`)
  return route.abort()
})
const page = await context.newPage()
page.on("pageerror", (error) => errors.push(error.message))
const active = () => page.locator(".float-editor").or(page.locator(".prompt-box:not([inert])"))
const editor = () => active().locator("textarea")
const mode = (name) => active().getByRole("radio", { name, exact: true })
const action = (name) => active().getByRole("button", { name, exact: true })
const posts = (path) => fixture.calls.filter((call) => call.method === "POST" && call.path.endsWith(path))
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
const image = (filename) => ({ type: "file", mime: "image/png", url: `data:image/png;base64,${png}`, filename })
const paste = async (...names) => {
  const before = await active()
    .getByRole("button", { name: /^Remove / })
    .count()
  await editor().evaluate(
    (el, { names, png }) => {
      const data = new DataTransfer()
      for (const name of names) {
        data.items.add(
          new File([Uint8Array.from(atob(png), (char) => char.charCodeAt(0))], name, { type: "image/png" }),
        )
      }
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }))
    },
    { names, png },
  )
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(before + names.length)
}
const clearImages = async () => {
  while (
    await active()
      .getByRole("button", { name: /^Remove / })
      .count()
  )
    await active()
      .getByRole("button", { name: /^Remove / })
      .first()
      .click()
}

try {
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await expect(mode("Queue")).toHaveAttribute("aria-checked", "true")
  await paste("repeat.png", "repeat.png")
  await expect(action("Queue message")).toBeEnabled()
  fixture.holdInput = true
  await action("Queue message").click()
  const admissionImages = page.locator(".input-admission").getByRole("group", { name: "Attached images" })
  await expect(admissionImages).toContainText("2 images")
  await expect(admissionImages.getByRole("img", { name: "repeat.png", exact: true })).toHaveCount(2)
  await expect(admissionImages).not.toContainText("data:image")
  await expect.poll(() => fixture.inputReplies.length).toBe(1)
  fixture.holdInput = false
  fixture.inputReplies.shift()()
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(0)
  const firstReceipt = page.locator(`[data-request-id="${posts("/input")[0].body.requestID}"]`)
  await expect(firstReceipt.getByRole("group", { name: "Attached images" })).toContainText("2 images")
  await expect(firstReceipt.getByRole("img", { name: "repeat.png", exact: true })).toHaveCount(2)
  expect(posts("/input")[0].body).toEqual({
    requestID: expect.any(String),
    delivery: "queue",
    text: "",
    images: [image("repeat.png"), image("repeat.png")],
  })

  await editor().fill("task images")
  await paste("first.png")
  await paste("second.png")
  await paste("first.png")
  await mode("Aside").click()
  await expect(editor()).toHaveValue("task images")
  await active().getByRole("button", { name: "Remove second.png", exact: true }).click()
  await editor().fill("")
  fixture.holdAside = true
  await action("Ask aside").click()
  await expect.poll(() => fixture.asideReplies.length).toBe(1)
  const asideImages = page.locator(".aside-result").getByRole("group", { name: "Attached images" })
  await expect(asideImages).toContainText("2 images")
  await expect(asideImages.getByRole("img", { name: "first.png", exact: true })).toHaveCount(2)
  expect(posts("/aside").at(-1).body).toEqual({
    requestID: expect.any(String),
    question: "",
    images: [image("first.png"), image("first.png")],
  })
  await editor().fill("next aside")
  await paste("later.png")
  await mode("Steer").click()
  await expect(editor()).toHaveValue("task images")
  await action("Steer task").click()
  await expect(editor()).toHaveValue("")
  expect(posts("/input").at(-1).body).toEqual({
    requestID: expect.any(String),
    delivery: "steer",
    text: "task images",
    images: [image("first.png"), image("second.png"), image("first.png")],
  })
  fixture.holdAside = false
  fixture.asideReplies.shift()()
  await expect(page.getByRole("region", { name: "Aside result" })).toContainText("ASIDE ONLY")
  await expect(asideImages).toContainText("2 images")
  await expect(asideImages).not.toContainText("later.png")
  await expect(page.locator(".transcript")).not.toContainText("ASIDE ONLY")
  await mode("Aside").click()
  await expect(editor()).toHaveValue("next aside")
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(3)
  await page.getByRole("button", { name: "Close aside", exact: true }).click()

  await mode("Queue").click()
  await editor().fill("")
  await paste("first.png")
  await paste("second.png")
  await paste("first.png")
  fixture.loseInput = true
  await action("Queue message").click()
  await expect(page.locator(".input-admission")).toContainText("Admission unknown")
  await expect(admissionImages).toContainText("3 images")
  expect(await admissionImages.getByRole("img").evaluateAll((images) => images.map((image) => image.alt))).toEqual([
    "first.png",
    "second.png",
    "first.png",
  ])
  const original = posts("/input").at(-1).body
  await editor().fill("new draft after unknown")
  await active().getByRole("button", { name: "Remove second.png", exact: true }).click()
  await page.reload()
  await expect(editor()).toHaveValue("new draft after unknown")
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(2)
  await expect(admissionImages).toContainText("3 images")
  await expect(admissionImages.getByRole("img", { name: "second.png", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Check and retry same input", exact: true }).click()
  await expect(page.locator(".input-admission")).toHaveCount(0)
  expect(posts("/input").at(-1).body).toEqual(original)
  await expect(editor()).toHaveValue("new draft after unknown")
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(2)
  await expect(page.locator(`[data-request-id="${original.requestID}"]`).getByRole("img")).toHaveCount(3)
  await page
    .locator(`[data-request-id="${original.requestID}"]`)
    .getByRole("button", { name: /Cancel queue/ })
    .click()
  await expect(page.locator(`[data-request-id="${original.requestID}"]`)).toHaveCount(0)
  expect(fixture.receipts.find((receipt) => receipt.requestID === original.requestID).state).toBe("cancelled")

  fixture.acceptedAckLost = true
  const beforeReconcile = posts("/input").length
  await action("Queue message").click()
  await expect(page.locator(".input-admission")).toContainText("Admission unknown")
  fixture.emit("session.input.updated", { sessionID: "ses_a" })
  await expect(page.locator(".input-admission")).toHaveCount(0)
  expect(posts("/input")).toHaveLength(beforeReconcile + 1)
  await expect(editor()).toHaveValue("")
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(0)

  fixture.rejectImages = true
  await editor().fill("unsupported model draft")
  await paste("rejected.png")
  await action("Queue message").click()
  await expect(active()).toContainText("Selected model does not support image input")
  await expect(editor()).toHaveValue("unsupported model draft")
  await expect(active().getByRole("button", { name: "Remove rejected.png", exact: true })).toBeVisible()
  await mode("Steer").click()
  await action("Steer task").click()
  await expect(active()).toContainText("Selected model does not support image input")
  await expect(editor()).toHaveValue("unsupported model draft")
  await mode("Aside").click()
  await clearImages()
  await editor().fill("")
  await paste("rejected.png")
  await action("Ask aside").click()
  await expect(page.locator(".aside-result")).toContainText("Selected model does not support image input")
  await expect(asideImages).toContainText("1 image")
  await expect(asideImages.getByRole("img", { name: "rejected.png", exact: true })).toBeVisible()
  await expect(active().getByRole("button", { name: "Remove rejected.png", exact: true })).toBeVisible()
  await expect(editor()).toHaveValue("")
  await page.getByRole("button", { name: "Close aside", exact: true }).click()
  fixture.rejectImages = false

  for (const descriptor of [undefined, { ...imageCapability, version: 2 }]) {
    fixture.images = descriptor
    await page.reload()
    await expect(active()).toContainText("does not support images")
    const before = fixture.calls.filter((call) => call.method === "POST").length
    await expect(action("Ask aside")).toBeDisabled()
    await mode("Queue").click()
    await expect(action("Queue message")).toBeDisabled()
    await expect(editor()).toHaveValue("unsupported model draft")
    await expect(active().getByRole("button", { name: "Remove rejected.png", exact: true })).toBeVisible()
    await mode("Steer").click()
    await expect(action("Steer task")).toBeDisabled()
    expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(before)
    await mode("Aside").click()
  }
  await clearImages()
  await editor().fill("old server text aside")
  await action("Ask aside").click()
  await expect(page.locator(".aside-result")).toContainText("ASIDE ONLY")
  expect(posts("/aside").at(-1).body).toEqual({ requestID: expect.any(String), question: "old server text aside" })
  await page.getByRole("button", { name: "Close aside", exact: true }).click()
  await mode("Queue").click()
  await clearImages()
  await action("Queue message").click()
  await expect(editor()).toHaveValue("")
  expect(posts("/input").at(-1).body.images).toBeUndefined()

  fixture.setStatus("idle")
  await expect(active().locator(".composer-normal-mode")).toHaveText("Normal Send")
  await paste("normal.png", "normal.png")
  fixture.rejectImages = true
  await action("Send").click()
  await expect(active()).toContainText("Selected model does not support image input")
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(2)
  fixture.rejectImages = false
  await expect(action("Send")).toBeDisabled()
  await page.getByRole("button", { name: "Dismiss send status", exact: true }).click()
  await action("Send").click()
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(0)
  expect(posts("/prompt_async").at(-1).body.parts).toEqual([image("normal.png"), image("normal.png")])

  fixture.images = imageCapability
  fixture.setStatus("busy")
  await page.reload()
  await action("Choose message delivery").click()
  await expect(mode("Queue")).toHaveAttribute("aria-checked", "true")
  await paste(...Array.from({ length: 9 }, () => "count.png"))
  await expect(active()).toContainText("At most 8 images")
  await expect(action("Queue message")).toBeDisabled()
  await active().getByRole("button", { name: "Remove count.png", exact: true }).first().click()
  await expect(action("Queue message")).toBeEnabled()
  await clearImages()

  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("es-app:composer:") && value.includes("data:image"))
        throw new DOMException("Fixture quota exceeded", "QuotaExceededError")
      return setItem.call(this, key, value)
    }
  })
  await editor().fill("quota draft")
  await paste("quota.png")
  const beforeQuota = posts("/input").length
  await action("Queue message").click()
  await expect(active()).toContainText("No input was sent")
  await expect(editor()).toHaveValue("quota draft")
  await expect(active().getByRole("button", { name: "Remove quota.png", exact: true })).toBeVisible()
  expect(posts("/input")).toHaveLength(beforeQuota)
  await mode("Aside").click()
  await paste("quota.png")
  const beforeAsideQuota = posts("/aside").length
  await action("Ask aside").click()
  await expect(active()).toContainText("No Aside was sent")
  expect(posts("/aside")).toHaveLength(beforeAsideQuota)
  await expect(active().getByRole("button", { name: "Remove quota.png", exact: true })).toBeVisible()
  await mode("Queue").click()
  await page.reload()
  await expect(active()).toContainText("Images are missing")
  await expect(action("Queue message")).toBeDisabled()
  await expect(page.locator(".input-admission")).toHaveCount(0)

  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  expect(fixture.calls.filter((call) => call.method === "POST").every((call) => call.directory === directory)).toBe(
    true,
  )
  console.log(
    "PASS composer image transport: image-only/repeats, Aside isolation, exact retry/reload, reconciliation/cancel, model rejection, old/unknown capabilities, normal Send parity, count/quota gates",
  )
} finally {
  await browser.close()
  await vite.close()
  await fixture.close()
}
