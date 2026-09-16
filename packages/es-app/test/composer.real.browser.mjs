// Historical four-mode UI coverage. Real direct-action probes run composer-direct.real.browser.mjs.
import { createRequire } from "node:module"
import { mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const app = new URL(process.env.ES_APP_URL)
const control = new URL(process.env.COMPOSER_DEMO_CONTROL)
if (
  [app, control].some((url) => url.hostname !== "127.0.0.1" || !url.port || ["4096", "7777", "3100"].includes(url.port))
) {
  throw new Error("Explicit isolated loopback app and demo-control URLs are required")
}
const request = async (url, method = "GET") => {
  const response = await fetch(url, { method })
  if (!response.ok) throw new Error(`${method} ${new URL(url).pathname}: ${response.status}`)
  return response.json()
}
const state = await request(new URL("/demo/status", control))
const providers = await request(new URL("/oc/config/providers", app))
const spaces = await request(new URL("/es/api/editspaces", app))
if (
  !state.ready ||
  providers.providers.length !== 1 ||
  providers.providers[0].id !== "fixture" ||
  new URL(providers.providers[0].options.baseURL).origin !== control.origin ||
  spaces.default !== "composer-demo"
) {
  throw new Error("Fixture isolation check failed; refusing browser mutations")
}
const directory = spaces.editspaces.find((space) => space.name === "composer-demo").root
const status = () => request(new URL("/demo/status", control))
const action = (name) => request(new URL(`/demo/${name}`, control), "POST")
const api = (suffix) =>
  request(new URL(`/oc/session/${state.sessionID}/${suffix}?directory=${encodeURIComponent(directory)}`, app))
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const unexpected = []
const errors = []
const mutations = []
await context.route("**/*", (route) => {
  const url = new URL(route.request().url())
  if (url.origin !== app.origin && !["blob:", "data:"].includes(url.protocol)) {
    unexpected.push(url.origin)
    return route.abort()
  }
  if (route.request().method() !== "GET") {
    mutations.push(url.pathname)
    if (!new RegExp(`^/oc/session/${state.sessionID}/(aside|input)(/[^/]+)?$`).test(url.pathname)) {
      unexpected.push(url.pathname)
      return route.abort()
    }
  }
  return route.continue()
})
const page = await context.newPage()
page.on("pageerror", (error) => errors.push(error.message))
const artifacts = fileURLToPath(new URL("../artifacts/composer/", import.meta.url))
await mkdir(artifacts, { recursive: true })
const composer = page.locator(".prompt-box:not([inert])")
const editor = composer.locator("textarea")
const mode = (name) => composer.getByRole("radio", { name, exact: true })
try {
  await action("finish")
  await expect.poll(async () => (await status()).status.type).toBe("idle")
  await action("start")
  await expect.poll(async () => (await status()).held.some((hold) => hold.kind === "main")).toBe(true)
  await page.goto(new URL(`/session/${state.sessionID}?directory=${encodeURIComponent(directory)}`, app).href)
  await expect(mode("Queue")).toHaveAttribute("aria-checked", "true")
  const before = await api("message")
  await expect(page.locator('.transcript [data-component="markdown"]').first()).toHaveCSS("color", "rgb(205, 214, 244)")
  await editor.fill("Saved real task draft")
  await mode("Aside").click()
  await editor.fill("What is the task doing right now?")
  await composer.getByRole("button", { name: "Ask aside", exact: true }).click()
  await expect(page.locator(".aside-answer")).toContainText("separate snapshot answer", { timeout: 15000 })
  expect((await api("message")).length).toBe(before.length)
  expect((await status()).status.type).toBe("busy")
  await page.screenshot({ path: `${artifacts}/real-desktop.png`, fullPage: true })
  await page.getByRole("button", { name: "Close aside", exact: true }).click()
  await editor.fill("hold")
  await composer.getByRole("button", { name: "Ask aside", exact: true }).click()
  await expect.poll(async () => (await status()).held.some((hold) => hold.kind === "aside")).toBe(true)
  await page.getByRole("button", { name: "Cancel aside", exact: true }).click()
  await expect(page.locator(".aside-result")).toContainText("cancelled")
  expect((await status()).status.type).toBe("busy")
  expect((await api("message")).length).toBe(before.length)
  await page.getByRole("button", { name: "Close aside", exact: true }).click()

  const suffix = Date.now()
  const queueText = `Browser queue ${suffix}`
  const steerText = `Browser steer ${suffix}`
  await mode("Queue").click()
  await expect(editor).toHaveValue("Saved real task draft")
  await editor.fill(queueText)
  await composer.getByRole("button", { name: "Queue message", exact: true }).click()
  const queueRow = page.locator(".input-receipts li").filter({ hasText: queueText })
  await expect(queueRow).toContainText("pending")
  await mode("Steer").click()
  await editor.fill(steerText)
  await editor.press("Control+Enter")
  const steerRow = page.locator(".input-receipts li").filter({ hasText: steerText })
  await expect(steerRow).toContainText("pending")
  await action("step")
  await expect(steerRow).toHaveCount(0, { timeout: 15000 })
  await expect(queueRow).toContainText("pending")
  await expect(page.locator(".transcript")).toContainText(steerText)
  await expect(page.locator(".transcript")).not.toContainText(queueText)

  await mode("Queue").click()
  await editor.fill(`Cancel this input ${suffix}`)
  await composer.getByRole("button", { name: "Queue message", exact: true }).click()
  const cancelledRow = page.locator(".input-receipts li").filter({ hasText: `Cancel this input ${suffix}` })
  await cancelledRow.getByRole("button", { name: /Cancel queue input/ }).click()
  await expect(cancelledRow).toHaveCount(0)
  await action("finish")
  await expect(queueRow).toHaveCount(0, { timeout: 15000 })
  await expect(page.locator(".transcript")).toContainText(queueText)
  await expect.poll(async () => (await status()).status.type).toBe("idle")
  await expect(composer.locator(".composer-normal-mode")).toHaveText("Normal Send")

  await action("question")
  await expect(page.locator(".banner.question")).toContainText("Keep this question pending", { timeout: 15000 })
  await mode("Aside").click()
  await editor.fill("Explain the pending question")
  await composer.getByRole("button", { name: "Ask aside", exact: true }).click()
  await expect(page.locator(".aside-answer")).toContainText("separate snapshot answer", { timeout: 15000 })
  await expect(page.locator(".banner.question")).toContainText("Keep this question pending")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator(".banner.question").getByRole("button", { name: "answer", exact: true }).click({ trial: true })
  await page.screenshot({ path: `${artifacts}/real-mobile-approval.png`, fullPage: true })
  await page.getByRole("button", { name: "Close aside", exact: true }).click({ trial: true })
  await editor.scrollIntoViewIfNeeded()
  await expect(editor).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: `${artifacts}/real-mobile-question.png`, fullPage: true })
  await action("answer")
  await action("finish")
  await expect.poll(async () => (await status()).status.type).toBe("idle")
  await action("start")
  await expect.poll(async () => (await status()).held.some((hold) => hold.kind === "main")).toBe(true)
  expect(unexpected).toEqual([])
  expect(errors).toEqual([])
  expect(mutations.some((path) => /abort|permission|question|prompt_async/.test(path))).toBe(false)
  console.log(
    "PASS real combined backend: Aside isolation/cancel, safe-boundary Steer, idle Queue, input cancel, human question unchanged, mobile; fixture left busy",
  )
} finally {
  await browser.close()
}
