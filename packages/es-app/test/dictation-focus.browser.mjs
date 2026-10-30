// Laptop2579: local native voice stub only; no capture, permission request, model or submission.
import { createRequire } from "node:module"
import { request } from "node:http"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const mini = await createFixture()
mini.permissions = []
mini.questions = []
const proxy = {
  name: "test:voice-focus-host",
  configureServer(server) { server.middlewares.use((req, res, next) => {
    const match = /^\/hosts\/mini\/oc(\/.*)$/.exec(req.url ?? "")
    if (!match) return next()
    const upstream = request(`${mini.url}${match[1]}`, { method: req.method, headers: { ...req.headers, host: new URL(mini.url).host } }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  }) },
}
const preview = await startPanelPreview([proxy])
const browser = await chromium.launch({ headless: true, channel: "chrome" })
try {
  for (const view of ["local", "mini", "desk"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, userAgent: "Editspace fixture Electron/42.3.3", reducedMotion: "reduce" })
    await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
    if (view === "desk") await context.addInitScript(({ directory }) => localStorage.setItem("es-app:front-desk:1", JSON.stringify({ session: "ses_a", directory })), { directory })
    const page = await context.newPage()
    await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Laptop", remote: false, hosts: [], work: [
      { id: "local", label: "Laptop", origin: preview.origin }, { id: "mini", label: "Mac Mini", origin: "https://mini.example.ts.net" },
    ] } }))
    await page.route("**/__es/events", (route) => route.fulfill({ json: { protocol: null } }))
    let stopped
    await page.route("**/__es/voice{,/**}", (route) => {
      if (new URL(route.request().url()).pathname === "/__es/voice") return route.fulfill({ json: { available: true, state: "idle" } })
      if (route.request().url().endsWith("/stop")) { stopped = route; return }
      return route.fulfill({ json: { ok: true } })
    })
    const root = () => page.locator(view === "desk" ? ".desk-companion" : ".session-page:not(.desk-companion .session-page)")
    const editor = () => root().getByRole("textbox", { name: "Message", exact: true })
    const mic = () => root().locator(".dictation-toggle")
    await page.goto(`${preview.origin}${view === "desk" ? "/" : `/session/ses_a?directory=${encodeURIComponent(directory)}${view === "mini" ? "&host=mini" : ""}`}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
    await expect(editor()).toBeVisible()
    for (const kind of ["short", "multiline", "short-blurred-start", "multiline-blurred-start", "focus-moved"]) {
      const transcript = kind.startsWith("short") ? "dictated text" : Array.from({ length: 20 }, (_, i) => `Dictated line ${i + 1} with enough words to wrap in the Desk composer.`).join("\n")
      await editor().fill("")
      await editor().fill("Before after")
      await editor().evaluate((el) => el.setSelectionRange(7, 7))
      const original = await editor().elementHandle()
      const before = await editor().boundingBox()
      if (kind.endsWith("blurred-start")) await editor().evaluate((el) => el.blur())
      stopped = undefined
      await mic().click()
      await expect(mic()).toHaveAccessibleName("Stop dictation and transcribe")
      await mic().click()
      await expect.poll(() => !!stopped).toBe(true)
      if (kind === "focus-moved") {
        await page.evaluate(() => {
          const input = document.createElement("input")
          input.setAttribute("aria-label", "Fixture other input")
          document.body.append(input)
          input.focus()
        })
      }
      await stopped.fulfill({ json: { ok: true, text: transcript } })
      await expect(editor()).toHaveValue(`Before ${transcript} after`)
      if (!kind.startsWith("short")) await expect.poll(async () => (await editor().boundingBox()).height).toBeGreaterThan(before.height + 20)
      expect(await editor().evaluate((el, original) => el === original, original)).toBe(true)
      if (kind === "focus-moved") {
        await expect(page.getByRole("textbox", { name: "Fixture other input", exact: true })).toBeFocused()
        console.log(`PASS ${view}/${kind}: same textarea, result retained, other input keeps focus`)
        continue
      }
      await expect(editor()).toBeFocused()
      expect(await editor().evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([7 + transcript.length, 7 + transcript.length])
      // Deliver Cmd+Enter from the actual focus owner, but block it before the composer submission
      // handler: this is a focus/keyboard regression test, never an automatic send.
      expect(await editor().evaluate((el) => {
        let reached = false
        const intercept = (event) => { reached = event.target === el; event.preventDefault(); event.stopImmediatePropagation() }
        el.addEventListener("keydown", intercept, { capture: true, once: true })
        document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", metaKey: true, bubbles: true, cancelable: true }))
        el.removeEventListener("keydown", intercept, true)
        return reached
      })).toBe(true)
      console.log(`PASS ${view}/${kind}: same textarea focused, caret after insertion, Cmd+Enter routed to editor; height ${before.height} -> ${(await editor().boundingBox()).height}`)
    }
    await context.close()
  }
  for (const fixture of [preview.fixture, mini])
    expect(fixture.calls.filter((call) => call.method !== "GET" && call.path !== "/api/attention/session")).toEqual([])
} finally {
  await browser.close()
  await preview.close()
  await mini.close()
}
