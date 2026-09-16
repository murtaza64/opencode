import { createRequire } from "node:module"
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const app = new URL(process.env.ES_APP_URL)
const control = new URL(process.env.COMPOSER_DEMO_CONTROL)
if (
  [app, control].some((url) => url.hostname !== "127.0.0.1" || !url.port || ["4096", "7777", "3100"].includes(url.port))
)
  throw new Error("Explicit isolated loopback URLs required")
const json = async (url) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}
const state = await json(new URL("/demo/status", control))
const providers = await json(new URL("/oc/config/providers", app))
const spaces = await json(new URL("/es/api/editspaces", app))
if (
  !state.ready ||
  state.status.type !== "busy" ||
  !state.held.some((hold) => hold.kind === "main") ||
  providers.providers.length !== 1 ||
  providers.providers[0].id !== "fixture" ||
  new URL(providers.providers[0].options.baseURL).origin !== control.origin ||
  spaces.default !== "composer-demo"
)
  throw new Error("Prepare an isolated, paused fixture before running; no reset was attempted")
const directory = spaces.editspaces.find((space) => space.name === "composer-demo").root
const messages = () =>
  json(new URL(`/oc/session/${state.sessionID}/message?directory=${encodeURIComponent(directory)}`, app))
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage()
const unexpected = []
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/*", (route) => {
  const url = new URL(route.request().url())
  if (url.origin !== app.origin) {
    unexpected.push(url.origin)
    return route.abort()
  }
  if (
    route.request().method() !== "GET" &&
    !new RegExp(`^/oc/session/${state.sessionID}/(aside|input)(/[^/]+)?$`).test(url.pathname)
  ) {
    unexpected.push(url.pathname)
    return route.abort()
  }
  return route.continue()
})
try {
  await page.goto(new URL(`/session/${state.sessionID}?directory=${encodeURIComponent(directory)}`, app).href, {
    waitUntil: "domcontentloaded",
  })
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  const before = (await messages()).length
  await editor.fill("Explain the current fixture snapshot")
  await page.getByRole("button", { name: "Aside", exact: true }).click()
  await expect(page.locator(".aside-answer")).toContainText("separate snapshot answer", { timeout: 15000 })
  expect((await messages()).length).toBe(before)
  await page.getByRole("button", { name: "Close aside", exact: true }).click()
  for (const action of ["Queue", "Steer"]) {
    const text = `Direct ${action} probe ${crypto.randomUUID()}`
    await editor.fill(text)
    const response = page.waitForResponse(
      (response) => new URL(response.url()).pathname.endsWith("/input") && response.request().method() === "POST",
    )
    await page.getByRole("button", { name: action, exact: true }).click()
    const receipt = await (await response).json()
    expect(receipt.text).toBe(text)
    expect(receipt.delivery).toBe(action.toLowerCase())
    await page
      .locator(`[data-request-id="${receipt.requestID}"]`)
      .getByRole("button", { name: /^Cancel/ })
      .click()
    await expect(page.locator(`[data-request-id="${receipt.requestID}"]`)).toHaveCount(0)
  }
  expect((await json(new URL("/demo/status", control))).status.type).toBe("busy")
  expect(unexpected).toEqual([])
  expect(errors).toEqual([])
  console.log(
    "PASS real paused fixture: direct Aside isolation, Queue/Steer admission and own-input cancellation; no reset/step/parent abort",
  )
} finally {
  await browser.close()
}
