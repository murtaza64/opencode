// Draft-first New session (dotfiles#240): the button opens /new ready to type
// with defaults; nothing is created until Send; Send creates with the chosen
// agent/model/workspace, then the new session's own composer sends the text
// once. Failures keep the draft; a lost create response blocks another Send
// until an explicit recheck. Run from packages/es-app: node test/new-session.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const root = "/fixture with spaces/a&b?#"
const lane = `${root}/.editspace/lanes/feature/repos/example/app`
fixture.workspaceSessions.push({ ...fixture.messages[1].info, id: "ses_workspace", title: "Workspace", directory: lane, projectID: "fixture", time: { created: 1, updated: 2 } })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const createCalls = () => fixture.calls.filter(call => call.method === "POST" && call.path === "/session")
const promptCalls = (id) => fixture.calls.filter(call => call.method === "POST" && call.path === `/session/${id}/prompt_async`)
const editor = () => page.getByRole("textbox", { name: "Message", exact: true })
const settings = () => page.getByRole("group", { name: "New session settings" })
const send = () => page.getByRole("button", { name: /^(Send|Creating…)/ })
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  await expect(editor()).toBeVisible({ timeout: 90_000 })

  // Opens on the same click, focused, with project defaults; nothing created yet.
  await page.getByRole("link", { name: "New session", exact: true }).click()
  await expect(page).toHaveURL(/\/new$/)
  await expect(page.getByRole("heading", { name: "New session" })).toBeVisible()
  await expect(editor()).toBeFocused()
  await expect(settings().getByLabel("Project")).toHaveValue("fixture")
  await expect(settings().getByLabel("Workspace")).toHaveValue(root)
  await expect(settings().getByLabel("Agent")).toContainText("default agent")
  await expect(send()).toBeDisabled()
  expect(createCalls()).toHaveLength(0)
  await expect(page.getByRole("dialog")).toHaveCount(0)

  // Customise before sending: workspace, agent, model.
  await settings().getByLabel("Workspace").selectOption(lane)
  await settings().getByLabel("Agent").selectOption("build")
  await settings().getByLabel("Model").selectOption({ label: "next" })

  // Known failure keeps the draft and allows another Send.
  fixture.createMode = "fail"
  await editor().fill("Plan the migration")
  await send().click()
  await expect(page.getByRole("alert")).toContainText("Session creation failed")
  await expect(editor()).toHaveValue("Plan the migration")
  await expect(send()).toBeEnabled()
  await expect(page).toHaveURL(/\/new$/)

  // Lost response: possibly created, so Send waits for an explicit recheck; the draft survives reload.
  fixture.createMode = "lose"
  await editor().press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter")
  await expect(page.getByRole("alert")).toContainText("may have been created")
  await expect(send()).toBeDisabled()
  await page.reload()
  await expect(editor()).toHaveValue("Plan the migration")
  await expect(settings().getByLabel("Workspace")).toHaveValue(lane)

  // Pending create disables duplicate sends; confirmation navigates and the session sends once.
  fixture.createMode = "hold"
  const before = createCalls().length
  await send().click()
  await expect(send()).toHaveText(/Creating…/)
  await expect(send()).toBeDisabled()
  await editor().press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter")
  expect(createCalls().length).toBe(before + 1)
  const create = createCalls().at(-1)
  expect(create.directory).toBe(lane)
  expect(create.body).toEqual({ agent: "build", model: { providerID: "fixture", id: "next" } })
  fixture.createReplies.shift()()
  fixture.createMode = "complete"
  const created = fixture.created.at(-1)
  await expect(page).toHaveURL(new RegExp(`/session/${created.id}\\?directory=`))
  await expect.poll(() => promptCalls(created.id).length).toBe(1)
  expect(promptCalls(created.id)[0].body.parts[0].text).toBe("Plan the migration")
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeFocused()
  // Back does not return to an emptied draft, and a reload never resends.
  await page.reload()
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible()
  await page.waitForTimeout(500)
  expect(promptCalls(created.id)).toHaveLength(1)

  // The next New session remembers the last project and model; the draft is fresh.
  await page.getByRole("link", { name: "New session", exact: true }).click()
  await expect(editor()).toHaveValue("")
  await expect(settings().getByLabel("Model")).toHaveValue("fixture\u0000next")

  // RTL and 390px: the settings row wraps and Send stays reachable.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await page.setViewportSize({ width: 390, height: 844 })
  await editor().fill("مرحبا")
  await expect(send()).toBeInViewport()
  expect(await page.locator(".new-session-draft").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)

  expect(errors).toEqual([])
  console.log("PASS new session (draft-first): opens focused with defaults, no create before Send, customise workspace/agent/model, known failure keeps draft, lost response blocks until recheck and survives reload, duplicate guard, create body, one first send through the composer, no resend on reload, remembered model, RTL/390px")
} finally {
  await browser.close()
  await preview.close()
}
