import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, imageCapability } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.images = imageCapability
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const errors = []
await context.route("**/*", (route) => {
  const url = new URL(route.request().url())
  if (url.origin === preview.origin || ["data:", "blob:"].includes(url.protocol)) return route.continue()
  errors.push(`External request: ${url.origin}`)
  return route.abort()
})
const page = await context.newPage()
page.on("pageerror", (error) => errors.push(error.message))
const active = () => page.locator(".float-editor").or(page.locator(".prompt-box:not([inert])"))
const editor = () => active().getByRole("textbox", { name: "Message", exact: true })
const action = (name) => active().getByRole("button", { name, exact: true })
const posts = (path) => fixture.calls.filter((call) => call.method === "POST" && call.path.endsWith(path))
const hashes = (images) => images.map((image) => createHash("sha256").update(Buffer.from(image.url.split(",")[1], "base64")).digest("hex"))
const paste = async (images) => {
  const before = await active().getByRole("button", { name: /^Remove / }).count()
  await editor().evaluate((el, images) => {
    const data = new DataTransfer()
    for (const image of images) {
      data.items.add(new File([Uint8Array.from(atob(image.url.split(",")[1]), (char) => char.charCodeAt(0))], image.filename, { type: image.mime }))
    }
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }))
  }, images)
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(before + images.length)
}
const clearImages = async () => {
  while (await active().getByRole("button", { name: /^Remove / }).count())
    await active().getByRole("button", { name: /^Remove / }).first().click()
}

try {
  await mkdir("artifacts/direct-images", { recursive: true })
  const source = await context.newPage()
  await source.setContent('<div style="width:48px;height:32px;background:#123456">A</div>')
  const first = await source.locator("div").screenshot({ path: "artifacts/direct-images/source-a.png" })
  await source.setContent('<div style="width:48px;height:32px;background:#abcdef">B</div>')
  const second = await source.locator("div").screenshot({ path: "artifacts/direct-images/source-b.png" })
  await source.close()
  const a = { type: "file", mime: "image/png", url: `data:image/png;base64,${first.toString("base64")}`, filename: "a.png" }
  const b = { type: "file", mime: "image/png", url: `data:image/png;base64,${second.toString("base64")}`, filename: "b.png" }
  const expectedHashes = [createHash("sha256").update(first).digest("hex"), createHash("sha256").update(second).digest("hex")]
  const key = `es-app:composer:1:${JSON.stringify(["ses_a", directory])}`
  await context.addInitScript(({ key, image }) => {
    if (sessionStorage.getItem(key)) return
    const draft = { text: "", images: [], model: null, selection: [0, 0], revision: 0 }
    sessionStorage.setItem(key, JSON.stringify({
      version: 1, directView: 1, visibleBuffer: "aside", keyboardTarget: "queue", targetRevision: 7,
      mode: "send", asideSeeded: true,
      task: { ...draft, text: "Hidden task must not be sent", images: [{ ...image, id: "hidden", filename: "hidden.png" }] },
      aside: draft,
    }))
  }, { key, image: b })
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  await expect(action("Queue")).toHaveAttribute("data-keyboard-target", "true")
  await expect(editor()).toHaveValue("")
  await expect(active().getByRole("radio")).toHaveCount(0)
  await paste([a, b, a])
  fixture.holdAside = true
  await action("Aside").click()
  await expect.poll(() => fixture.asideReplies.length).toBe(1)
  expect(posts("/aside")[0].body).toEqual({ requestID: expect.any(String), question: "", images: [a, b, a] })
  expect(hashes(posts("/aside")[0].body.images)).toEqual([expectedHashes[0], expectedHashes[1], expectedHashes[0]])
  await expect(page.locator(".aside-result").getByRole("group", { name: "Attached images" })).toContainText("3 images")
  await clearImages()
  await paste([b])
  await editor().fill("Newer visible Aside draft")
  await editor().press("Alt+m")
  fixture.holdAside = false
  fixture.asideReplies.shift()()
  await expect(page.locator(".aside-answer")).toContainText("ASIDE ONLY")
  await expect(editor()).toHaveValue("Newer visible Aside draft")
  await expect(action("Remove b.png")).toBeVisible()
  await expect(action("Queue")).toHaveAttribute("data-keyboard-target", "true")
  await expect(page.locator(".transcript")).not.toContainText("ASIDE ONLY")
  expect(posts("/input")).toHaveLength(0)
  expect(posts("/prompt_async")).toHaveLength(0)
  await action("Restore saved task draft").click()
  await expect(editor()).toHaveValue("Hidden task must not be sent")
  await expect(action("Remove hidden.png")).toBeVisible()
  await action("Restore saved Aside draft").click()
  await expect(editor()).toHaveValue("Newer visible Aside draft")
  await page.getByRole("button", { name: "Close aside", exact: true }).click()
  await clearImages()
  await editor().fill("")

  await paste([a, b, a])
  fixture.holdInput = true
  await action("Queue").click()
  await expect.poll(() => fixture.inputReplies.length).toBe(1)
  expect(posts("/input")[0].body).toEqual({ requestID: expect.any(String), delivery: "queue", text: "", images: [a, b, a] })
  expect(hashes(posts("/input")[0].body.images)).toEqual([expectedHashes[0], expectedHashes[1], expectedHashes[0]])
  await editor().press("Alt+m")
  fixture.holdInput = false
  fixture.inputReplies.shift()()
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(0)
  await expect(action("Queue")).toHaveAttribute("data-keyboard-target", "true")
  await paste([b])
  await action("Steer").click()
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(0)
  expect(posts("/input").at(-1).body).toEqual({ requestID: expect.any(String), delivery: "steer", text: "", images: [b] })
  expect(hashes(posts("/input").at(-1).body.images)).toEqual([expectedHashes[1]])
  await expect(page.locator(".input-receipts summary")).toContainText("1 queued, 1 steer")
  await page.screenshot({ path: "artifacts/direct-images/pending.png", fullPage: true })

  await paste([a, b, a])
  fixture.loseInput = true
  await action("Queue").click()
  await expect(page.locator(".input-admission")).toContainText("Admission unknown")
  const original = posts("/input").at(-1).body
  await editor().fill("Newer draft after unknown")
  await action("Remove b.png").click()
  await editor().press("Alt+m")
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(editor()).toHaveValue("Newer draft after unknown")
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(2)
  await expect(action("Queue")).toHaveAttribute("data-keyboard-target", "true")
  const saved = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), key)
  expect(saved).toMatchObject({ directView: 1, visibleBuffer: "aside", keyboardTarget: "queue" })
  expect(saved.admission.buffer).toBe("aside")
  expect(saved.admission.targetRevision).toBeLessThan(saved.targetRevision)
  expect(saved.admission.payload).toEqual(original)
  const beforeRetry = fixture.calls.length
  await page.getByRole("button", { name: "Check and retry same input", exact: true }).click()
  await expect(page.locator(".input-admission")).toHaveCount(0)
  const retryCalls = fixture.calls.slice(beforeRetry)
  expect(retryCalls.findIndex((call) => call.method === "GET" && call.path.endsWith(`/input/${original.requestID}`))).toBeGreaterThanOrEqual(0)
  expect(retryCalls.findIndex((call) => call.method === "GET" && call.path.endsWith(`/input/${original.requestID}`))).toBeLessThan(retryCalls.findIndex((call) => call.method === "POST"))
  expect(posts("/input").at(-1).body).toEqual(original)
  expect(hashes(posts("/input").at(-1).body.images)).toEqual([expectedHashes[0], expectedHashes[1], expectedHashes[0]])
  await expect(editor()).toHaveValue("Newer draft after unknown")
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(2)
  await expect(action("Queue")).toHaveAttribute("data-keyboard-target", "true")

  for (const descriptor of [undefined, { ...imageCapability, version: 2 }]) {
    fixture.images = descriptor
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(active()).toContainText("does not support images")
    const before = fixture.calls.filter((call) => call.method === "POST").length
    await expect(action("Aside")).toBeDisabled()
    await expect(action("Queue")).toBeDisabled()
    await expect(action("Steer")).toBeDisabled()
    await editor().press("Control+Enter")
    expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(before)
    await expect(editor()).toHaveValue("Newer draft after unknown")
    await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(2)
  }

  fixture.images = imageCapability
  fixture.rejectImages = true
  await page.reload({ waitUntil: "domcontentloaded" })
  await action("Queue").click()
  await expect(active()).toContainText("Selected model does not support image input")
  await expect(editor()).toHaveValue("Newer draft after unknown")
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(2)
  await action("Steer").click()
  await expect(active()).toContainText("Selected model does not support image input")
  expect(posts("/input").at(-1).body.delivery).toBe("steer")
  await action("Aside").click()
  await expect(page.locator(".aside-result")).toContainText("Selected model does not support image input")
  await expect(editor()).toHaveValue("Newer draft after unknown")
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(2)
  await page.getByRole("button", { name: "Close aside", exact: true }).click()
  fixture.rejectImages = false

  fixture.setStatus("idle")
  await expect(page.locator(".topbar")).toContainText("idle")
  await editor().fill("")
  await action("Steer").click()
  await expect(active().getByRole("button", { name: /^Remove / })).toHaveCount(0)
  expect(posts("/prompt_async").at(-1).body.parts).toEqual([a, a])
  expect(hashes(posts("/prompt_async").at(-1).body.parts)).toEqual([expectedHashes[0], expectedHashes[0]])
  await expect(active()).not.toContainText("Normal Send")
  expect(fixture.calls.filter((call) => call.method === "POST").every((call) => call.directory === directory)).toBe(true)
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  console.log("PASS direct B images: image-only Aside/Queue/Steer, captured visible buffer, ordered duplicate hashes, exact GET-before-POST retry/reload, newer draft/target retention, capability and model rejection, idle chat parity", { sha256: expectedHashes })
} finally {
  await browser.close()
  await preview.close()
}
