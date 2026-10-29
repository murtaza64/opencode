// BUG-04: the native bridge stays local; focused and saved-draft insertion belong to the session's
// host. Two fixture Cores deliberately share the same session id and directory. No microphone,
// permission prompt, audio or model: only /__es/voice is stubbed at the native boundary.
import { createRequire } from "node:module"
import { request } from "node:http"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const mini = await createFixture()
mini.permissions = []
mini.questions = []
mini.sessionModels.set("ses_a", { providerID: "fixture", id: "test", variant: "default" })
let miniDown = false
const proxy = {
  name: "test:dictation-host",
  configureServer: (server) => { server.middlewares.use((req, res, next) => {
    const match = /^\/hosts\/mini\/oc(\/.*)$/.exec(req.url ?? "")
    if (!match) return next()
    if (miniDown) {
      res.writeHead(502, { "content-type": "application/json" })
      return res.end('{"error":"Host unavailable"}')
    }
    const upstream = request(`${mini.url}${match[1]}`, {
      method: req.method, headers: { ...req.headers, host: new URL(mini.url).host },
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  }) },
}
const preview = await startPanelPreview([proxy])
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  // Exercise the native profile's durable draft storage, not ordinary browser tab storage.
  userAgent: "Editspace fixture Electron/42.3.3",
})
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/__es/host", (route) => route.fulfill({ json: {
  id: "local", label: "Laptop", remote: false, hosts: [], work: [
    { id: "local", label: "Laptop", origin: preview.origin },
    { id: "mini", label: "Mac Mini", origin: "https://mini.example.ts.net" },
  ],
} }))
await page.route("**/__es/events", (route) => route.fulfill({ json: { protocol: null } }))
const calls = []
let stopRoute
let permission = true
await page.route("**/__es/voice{,/**}", async (route) => {
  const req = route.request()
  const action = new URL(req.url()).pathname.split("/").at(-1)
  calls.push({ path: new URL(req.url()).pathname, method: req.method() })
  if (action === "voice") return route.fulfill({ json: { available: true, state: "idle" } })
  if (action === "stop") { stopRoute = route; return }
  if (action === "start" && !permission)
    return route.fulfill({ status: 403, json: { ok: false, code: "permission", message: "Couldn't record: microphone access denied" } })
  return route.fulfill({ json: { ok: true } })
})
const editor = () => page.locator(".prompt-box").getByRole("textbox", { name: "Message", exact: true })
const mic = () => page.locator(".prompt-box .dictation-toggle")
const pill = () => page.locator(".prompt-box .dictation-pill")
const url = (host) => `/session/ses_a?directory=${encodeURIComponent(directory)}${host ? `&host=${host}` : ""}`
const navigate = async (host) => {
  await page.evaluate((url) => { history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate")) }, url(host))
  await expect(page.locator(host ? `.session-page[data-host='${host}']` : ".session-page:not([data-host])")).toBeVisible()
}
const navigateSession = async (session, host) => {
  await page.evaluate((url) => { history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate")) },
    `/session/${session}?directory=${encodeURIComponent(directory)}${host ? `&host=${host}` : ""}`)
  await expect(page.locator(host ? `.session-page[data-host='${host}']` : ".session-page:not([data-host])")).toBeVisible()
}
const record = async () => {
  await mic().click()
  await expect(mic()).toHaveAccessibleName("Stop dictation and transcribe")
}
const transcribe = async () => {
  stopRoute = undefined
  await mic().click()
  await expect.poll(() => !!stopRoute).toBe(true)
}
const text = (host) => page.evaluate(({ host, directory }) => {
  const key = `es-app:composer:1:${JSON.stringify(host ? ["ses_a", directory, host] : ["ses_a", directory])}`
  return JSON.parse(localStorage.getItem(key) ?? "null")?.task?.text
}, { host, directory })
try {
  await page.goto(`${preview.origin}${url()}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await editor().fill("Laptop draft")
  await navigate("mini")
  // Red on the shipped BUG-04 surface: remote SessionView supplies no DictationButton.
  await expect(mic()).toBeVisible()
  await expect(mic()).toBeEnabled()
  await expect(page.locator(".prompt-box .direct-model-name")).toContainText("Fixture model")
  await editor().fill("Please the parser.")
  await editor().evaluate((el) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0))], "voice-fixture.png", { type: "image/png" }))
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  await expect(page.getByRole("img", { name: "voice-fixture.png", exact: true })).toBeVisible()
  await editor().evaluate((el) => el.setSelectionRange(7, 7))
  await record()
  await transcribe()
  await stopRoute.fulfill({ json: { ok: true, text: "fix" } })
  await expect(editor()).toHaveValue("Please fix the parser.")
  await expect(editor()).toBeFocused()
  expect(await editor().evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([10, 10])
  await editor().press("ControlOrMeta+z")
  await expect(editor()).toHaveValue("Please the parser.")
  await editor().press("ControlOrMeta+Shift+z")
  await expect(editor()).toHaveValue("Please fix the parser.")

  await editor().evaluate((el) => el.setSelectionRange(el.value.length, el.value.length))
  await record()
  await transcribe()
  // Type while Whisper is pending, then switch hosts within the same renderer (no page reload).
  await editor().fill("Please fix the parser. Also")
  await editor().press("End")
  await navigate()
  await expect(editor()).toHaveValue("Laptop draft")
  await editor().focus()
  await stopRoute.fulfill({ json: { ok: true, text: "check the logs" } })
  await expect.poll(() => text("mini")).toBe("Please fix the parser. Also check the logs")
  await expect(editor()).toHaveValue("Laptop draft")
  await expect(editor()).toBeFocused()
  expect(await text()).toBe("Laptop draft")

  await navigate("mini")
  const original = "Please fix the parser. Also check the logs"
  await expect(editor()).toHaveValue(original)
  await record()
  await transcribe()
  await editor().press("Escape")
  await stopRoute.fulfill({ json: { ok: true, text: "cancelled late result" } })
  await expect(pill()).toHaveAttribute("data-phase", "idle")
  await expect(editor()).toHaveValue(original)

  // Navigating to another session on the same host must also leave its draft untouched.
  await editor().focus()
  await editor().evaluate((el) => el.setSelectionRange(el.value.length, el.value.length))
  await record()
  await transcribe()
  await navigateSession("ses_b", "mini")
  await editor().fill("Other Mini session")
  await stopRoute.fulfill({ json: { ok: true, text: "and add a test" } })
  await expect.poll(() => text("mini")).toBe(`${original} and add a test`)
  await expect(editor()).toHaveValue("Other Mini session")
  await navigate("mini")
  const offlineDraft = `${original} and add a test`
  await expect(editor()).toHaveValue(offlineDraft)
  await editor().focus()
  await editor().evaluate((el) => el.setSelectionRange(el.value.length, el.value.length))
  await record()
  await transcribe()
  miniDown = true
  // Refresh the host's existing reachability state via its normal request-change event.
  for (const [response, entry] of mini.eventStreams) {
    const event = { type: "permission.asked", properties: { sessionID: "ses_a" } }
    if (entry.path === "/global/event") response.write(`data: ${JSON.stringify({ directory, payload: event })}\n\n`)
    if (entry.path === "/event") response.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  // The existing host-labelled session reports the outage; dictation is still a local draft edit.
  await expect(page.locator(".session-host")).toContainText("Mac Mini")
  await expect(page.locator(".session-state")).toHaveText("disconnected", { timeout: 40_000 })
  await expect(page.locator(".session-work-status")).toContainText("Reconnecting")
  await stopRoute.fulfill({ json: { ok: true, text: "offline note" } })
  await expect(editor()).toHaveValue(`${offlineDraft} offline note`)
  await expect(editor()).toBeFocused()
  await expect(page.locator(".session-state")).toHaveText("disconnected")
  await expect(page.locator(".session-work-status")).toContainText("Reconnecting")
  expect(await text("mini")).toBe(`${offlineDraft} offline note`)
  expect(await text()).toBe("Laptop draft")
  await expect(page.getByRole("img", { name: "voice-fixture.png", exact: true })).toBeVisible()
  await expect(page.locator(".prompt-box .direct-model-name")).toContainText("Fixture model")
  expect(mini.sessionModels.get("ses_a")).toEqual({ providerID: "fixture", id: "test", variant: "default" })
  miniDown = false
  await editor().fill(original)

  await record()
  await transcribe()
  await stopRoute.fulfill({ status: 500, json: { ok: false, code: "failed", message: "Couldn't transcribe the recording", detail: "fixture failure" } })
  await expect(pill()).toHaveAttribute("data-phase", "error")
  await expect(pill().locator(".dictation-status")).toHaveAttribute("title", /fixture failure/)
  await expect(editor()).toHaveValue(original)
  await editor().press("Escape")

  permission = false
  await mic().click()
  await expect(pill()).toHaveAttribute("data-phase", "error")
  await expect(pill().getByRole("button", { name: "Open settings" })).toBeVisible()
  await expect(editor()).toHaveValue(original)
  await navigate()
  await expect(pill()).toHaveAttribute("data-phase", "idle")
  await expect(editor()).toHaveValue("Laptop draft")
  // Only the local native boundary is used. Neither Core receives a submission or model call.
  for (const fixture of [preview.fixture, mini])
    expect(fixture.calls.filter((call) => call.method !== "GET" && call.path !== "/api/attention/session")).toEqual([])
  expect(calls.filter((call) => call.method === "POST").every((call) => call.path.startsWith("/__es/voice/"))).toBe(true)
  expect(errors).toEqual([])
  console.log("PASS host-qualified dictation: remote focused edit/undo/caret, typed-meanwhile fallback after host/session switch, Local draft/focus isolation, image/model preserved, cancel/late result, Mini disconnected/reconnecting message + draft retained, failure, permission denied, no Core writes")
} finally {
  await browser.close()
  await preview.close()
  await mini.close()
}
