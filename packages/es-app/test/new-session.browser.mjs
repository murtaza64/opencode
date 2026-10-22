// Draft-first New session (dotfiles#240): the button opens /new ready to type
// with defaults; nothing is created until Send; Send creates with the chosen
// agent/model/workspace and a client-chosen id saved first, then the new
// session's own composer sends the text once. A lost create survives reload and
// is reconciled by that id (never a second create); a held session load keeps
// the text in the session's composer and never loses or resends it.
// Run from packages/es-app: node test/new-session.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.strictSessions = true
fixture.heldSessions = new Set()
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

  // Lost response, not created: settings and text lock to the attempt. Reload reads the id (404) and keeps
  // it reserved, since the lost request could still land; Send repeats the identical request, never a new id.
  fixture.createMode = "lose"
  await editor().press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter")
  await expect(page.getByRole("alert")).toContainText("may have been created")
  await expect(send()).toBeDisabled()
  await expect(settings().getByLabel("Workspace")).toBeDisabled()
  await expect(settings().getByLabel("Model")).toBeDisabled()
  const lost = createCalls().at(-1).body
  expect(lost.id).toMatch(/^ses_/)
  const afterLost = createCalls().length
  await page.reload()
  await expect(page.getByRole("alert")).toContainText("Not created yet")
  expect(createCalls().length).toBe(afterLost)
  await expect(editor()).toHaveValue("Plan the migration")
  for (const name of ["Project", "Workspace", "Agent", "Model"]) await expect(settings().getByLabel(name)).toBeDisabled()
  await expect(settings().getByLabel("Workspace")).toHaveValue(lane)
  await expect(settings().getByLabel("Model")).toHaveValue("fixture\u0000next")
  await expect(send()).toBeEnabled()
  // The retry is lost too: still the same id, still reserved after another reload.
  fixture.createMode = "lose"
  await send().click()
  await expect(page.getByRole("alert")).toContainText("may have been created")
  expect(createCalls().at(-1).body).toEqual(lost)
  await page.reload()
  await expect(page.getByRole("alert")).toContainText("Not created yet")
  // Confirmed on the identical request: opened and sent once.
  await send().click()
  expect(createCalls().at(-1).body).toEqual(lost)
  await expect(page).toHaveURL(new RegExp(`/session/${lost.id}\\?directory=`))
  await expect.poll(() => promptCalls(lost.id).length).toBe(1)
  expect(createCalls().filter((call) => call.body?.id !== lost.id).length).toBe(afterLost - 1)

  // Lost response, created: reload finds the exact id and opens it; the first message is sent once.
  await page.getByRole("link", { name: "New session", exact: true }).click()
  await settings().getByLabel("Workspace").selectOption(lane)
  await editor().fill("Plan the migration")
  fixture.createMode = "lose-after"
  await send().click()
  await expect(page.getByRole("alert")).toContainText("may have been created")
  await expect.poll(() => createCalls().at(-1).body.id).not.toBe(lost.id)
  const chosen = createCalls().at(-1)
  expect(chosen.body).toEqual({ id: expect.stringMatching(/^ses_/), agent: "build", model: { providerID: "fixture", id: "next" } })
  expect(chosen.directory).toBe(lane)
  const afterCreated = createCalls().length
  await page.reload()
  await expect(page).toHaveURL(new RegExp(`/session/${chosen.body.id}\\?directory=`))
  expect(createCalls().length).toBe(afterCreated)
  await expect.poll(() => promptCalls(chosen.body.id).length).toBe(1)
  expect(promptCalls(chosen.body.id)[0].body.parts[0].text).toBe("Plan the migration")
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("", { timeout: 15_000 })
  await page.reload()
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible()
  await page.waitForTimeout(500)
  expect(promptCalls(chosen.body.id)).toHaveLength(1)

  // Held session load: the text waits in that session's composer, survives reload, and is sent once when it loads.
  await page.getByRole("link", { name: "New session", exact: true }).click()
  await editor().fill("Second task")
  const nextID = () => createCalls().at(-1).body.id
  await page.route("**/oc/session?*", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}")
    if (body.id) fixture.heldSessions.add(body.id)
    await route.continue()
  })
  fixture.createMode = "hold"
  const beforeHeld = createCalls().length
  await send().click()
  await expect(send()).toHaveText(/Creating…/)
  await send().click({ force: true }).catch(() => undefined)
  await editor().press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter")
  expect(createCalls().length).toBe(beforeHeld + 1)
  fixture.createReplies.shift()()
  fixture.createMode = "complete"
  const held = nextID()
  await expect(page).toHaveURL(new RegExp(`/session/${held}\\?directory=`))
  // The submission was recorded and sent before the session view loaded; the held load cannot lose it.
  await expect.poll(() => promptCalls(held).length).toBe(1)
  expect(promptCalls(held)[0].body.parts[0].text).toBe("Second task")
  await page.reload()
  await page.waitForTimeout(500)
  expect(promptCalls(held)).toHaveLength(1)
  fixture.heldSessions.delete(held)
  await page.unroute("**/oc/session?*")
  await page.reload()
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("", { timeout: 15_000 })
  await page.waitForTimeout(500)
  expect(promptCalls(held)).toHaveLength(1)

  // Lost first-message response: the composer reports it unknown and never resends, even after reload.
  await page.getByRole("link", { name: "New session", exact: true }).click()
  await editor().fill("Third task")
  fixture.loseNormal = true
  const beforeThird = createCalls().length
  await send().click()
  await expect.poll(() => createCalls().length).toBe(beforeThird + 1)
  const lostSend = createCalls().at(-1).body.id
  await expect(page).toHaveURL(new RegExp(`/session/${lostSend}\\?directory=`))
  await expect(page.getByText(/Send not confirmed/).first()).toBeVisible({ timeout: 15_000 })
  await page.reload()
  await page.waitForTimeout(800)
  expect(promptCalls(lostSend)).toHaveLength(1)

  // The next New session remembers the last project and model; the draft is fresh.
  await page.getByRole("link", { name: "New session", exact: true }).click()
  await expect(page).toHaveURL(/\/new$/)
  await expect(editor()).toHaveValue("")
  await expect(settings().getByLabel("Model")).toHaveValue("fixture\u0000next")

  // RTL and 390px: the settings row wraps and Send stays reachable.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await page.setViewportSize({ width: 390, height: 844 })
  await editor().fill("مرحبا")
  await expect(send()).toBeInViewport()
  expect(await page.locator(".new-session-draft").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)

  expect(errors).toEqual([])
  console.log("PASS new session (draft-first): opens focused with defaults, no create before Send, customise workspace/agent/model, known failure keeps draft, lost create keeps its exact id and body reserved across reload and lost retries (404 -> settings stay locked, Send repeats the identical request; found -> opened and sent once; never a second id), duplicate guard, create body with client id/agent/model, lost first-message response stays unknown without resend, first message recorded and sent before the session view loads (a held load cannot lose it), sent once, no resend, remembered model, RTL/390px")
} finally {
  await browser.close()
  await preview.close()
}
