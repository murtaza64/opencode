import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const fixture = await createFixture()
fixture.status = "busy"
fixture.messages = []
process.env.OPENCODE_URL = process.env.ES_DASHBOARD_URL = fixture.url
const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { host: "127.0.0.1", port: 0 } })
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const page = await browser.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/*", (route) => {
  const url = new URL(route.request().url())
  if (url.origin !== origin) return route.abort()
  if (url.pathname === "/oc/permission") return route.fulfill({ json: [] })
  return route.continue()
})
const bar = () => page.locator(".session-work-status")
try {
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await expect(bar()).toHaveAttribute("data-state", "working")
  await expect(bar().locator(".session-work-spinner")).toBeVisible()
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  await page.clock.fastForward(20_000)
  await expect(bar()).toHaveAttribute("data-state", "working")
  console.log("PASS continuous working cue through 20 seconds of provider silence")
  const assistant = { id: "msg_assistant", sessionID: "ses_a", role: "assistant", parentID: "msg_user", agent: "build", mode: "build", modelID: "test", providerID: "fixture", time: { created: 1 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, path: { cwd: directory, root: directory }, cost: 0 }
  fixture.emit("message.updated", { info: assistant })
  fixture.emit("message.part.updated", { part: { id: "part_tool", messageID: assistant.id, sessionID: "ses_a", type: "tool", callID: "call_fixture", tool: "bash", state: { status: "running", input: { command: "fixture-only" }, time: { start: 1 } } } })
  await expect(bar()).toHaveAttribute("data-state", "working")
  for (const mode of ["Queue", "Aside", "Steer"]) {
    await page.getByRole("radio", { name: mode, exact: true }).click()
    await expect(bar()).toHaveAttribute("data-state", "working")
  }
  console.log("PASS tool execution and composer modes never hide busy feedback")
  fixture.emit("message.removed", { sessionID: "ses_a", messageID: assistant.id })
  await expect(bar()).toHaveAttribute("data-state", "working")
  fixture.emit("session.status", { sessionID: "ses_a", status: { type: "retry", attempt: 1, next: Date.now() + 1000, message: "Fixture retry" } })
  await expect(bar()).toHaveAttribute("data-state", "retry")
  fixture.emit("session.error", { sessionID: "ses_a", error: { name: "UnknownError", data: { message: "Fixture terminal error" } } })
  await expect(bar()).toHaveAttribute("data-state", "failed")
  await expect(bar().locator(".session-work-spinner")).toHaveCount(0)
  console.log("PASS between-message gap, retry and terminal-error transitions")
  fixture.setStatus("busy")
  await expect(bar()).toHaveAttribute("data-state", "working")
  fixture.setStatus("idle")
  await page.clock.fastForward(30_000)
  await expect(bar()).toHaveCount(0)
  expect(errors).toEqual([])
  expect(fixture.calls.filter((call) => call.method !== "GET")).toEqual([])
  console.log("PASS genuine idle clears cue; no real or synthetic prompts sent")
} finally {
  await browser.close()
  await fixture.close()
  await vite.close()
}
