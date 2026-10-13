import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const fixture = await createFixture()
const mentioned = `ses_${"O".repeat(26)}`
const sameA = `ses_${"A".repeat(26)}`
const sameB = `ses_${"B".repeat(26)}`
const unknown = `ses_${"z".repeat(26)}`
fixture.workspaceSessions = [
  { id: mentioned, title: "Orchestrator main", directory: "/fixture/orchestrator", projectID: "", time: { created: 1, updated: Date.now() } },
  { id: sameA, title: "Same title", directory: "/project/alpha", projectID: "", time: { created: 1, updated: Date.now() - 100 } },
  { id: sameB, title: "Same title", directory: "/project/beta", projectID: "", time: { created: 1, updated: Date.now() - 200 } },
]
process.env.OPENCODE_URL = fixture.url
process.env.ES_DASHBOARD_URL = fixture.url
const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { host: "127.0.0.1", port: 0 } })
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
const editor = () => page.locator(".prompt-box:not([inert]) textarea")
const picker = () => page.locator(".prompt-box .session-picker")
try {
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await expect(editor()).toBeVisible()
  await expect(page.locator('.sidebar a[href*="/session/ses_a"]').first()).toBeVisible()
  await expect.poll(() => fixture.calls.filter((call) => call.path === "/session/ses_a/message").length).toBeGreaterThan(0)
  const baselineGets = fixture.calls.filter((call) => call.method === "GET" && (call.path.endsWith("/message") || call.path === `/session/${mentioned}`)).length
  await editor().pressSequentially("@orch")
  await expect(picker().getByRole("option", { name: /Orchestrator main/ })).toBeVisible()
  expect(await picker().getByRole("option").allTextContents()).not.toContain("Composer fixture")
  await editor().press("Enter")
  await expect(editor()).toHaveValue(`@${mentioned} `)
  const chip = page.locator(".prompt-box .session-chip")
  await expect(chip).toContainText("Orchestrator main")
  expect(await chip.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const box = node.parentElement.querySelector("textarea").getBoundingClientRect()
    return rect.width > 0 && rect.left >= box.left && rect.right <= box.right
  })).toBe(true)
  await editor().press("ArrowLeft")
  await editor().press("ArrowLeft")
  await editor().press("ArrowLeft")
  await expect(chip).toHaveCount(0)
  await editor().press("End")
  await expect(chip).toHaveCount(1)
  await editor().press("ArrowLeft")
  await editor().press("Backspace")
  await expect(editor()).toHaveValue(" ")
  await editor().fill("@same")
  const same = picker().getByRole("option")
  await expect(same).toHaveCount(2)
  await expect(same.nth(0)).toContainText("alpha")
  await expect(same.nth(1)).toContainText("beta")
  await editor().press("Control+n")
  await expect(same.nth(1)).toHaveAttribute("aria-selected", "true")
  await editor().press("Control+p")
  await expect(same.nth(0)).toHaveAttribute("aria-selected", "true")
  await same.nth(1).dispatchEvent("mousedown", { button: 0 })
  await expect(editor()).toHaveValue(`@${sameB} `)
  await editor().fill("@same")
  await editor().press("Escape")
  await expect(picker()).toHaveCount(0)
  await editor().press("Escape")
  await expect(editor()).toHaveClass(/vim-normal/)
  await editor().fill("")
  await editor().press("Escape")
  await editor().press("@")
  await expect(picker()).toHaveCount(0)
  expect(fixture.calls.filter((call) => call.method === "GET" && (call.path.endsWith("/message") || call.path === `/session/${mentioned}`))).toHaveLength(baselineGets)
  await editor().press("i")
  await editor().fill(`@${mentioned} `)
  await editor().press("Control+Enter")
  await expect.poll(() => fixture.calls.filter((call) => call.path === "/session/ses_a/input" && call.method === "POST").length).toBe(1)
  expect(fixture.calls.find((call) => call.path === "/session/ses_a/input" && call.method === "POST").body.text).toContain(`@${mentioned}`)

  const info = { id: "msg_zmention", sessionID: "ses_a", role: "assistant", agent: "build", parentID: "msg_user", providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: Date.now() } }
  fixture.emit("message.updated", { info })
  fixture.emit("message.part.updated", { part: { id: "part_mention", messageID: info.id, sessionID: "ses_a", type: "text", text: `See @${mentioned} and ${unknown}` } })
  const resolved = page.locator(`.transcript .session-ref[data-session="${mentioned}"][data-resolved="1"]`)
  const missing = page.locator(`.transcript .session-ref[data-session="${unknown}"][data-unknown="1"]`)
  await expect(resolved).toContainText("@Orchestrator main")
  await expect(missing).toBeVisible()
  expect(await resolved.evaluate((el) => el.textContent)).toContain(mentioned)
  expect(fixture.calls.filter((call) => call.method === "GET" && call.path === `/session/${mentioned}`)).toHaveLength(0)
  await resolved.click()
  await expect(page).toHaveURL(`${origin}/session/${mentioned}?directory=${encodeURIComponent("/fixture/orchestrator")}`)
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  console.log("PASS session picker browser: insertion, chips, deletion, ranking, Vim, wire text, transcript navigation, no extra fetches")
} finally {
  await browser.close()
  await vite.close()
  await fixture.close()
}
