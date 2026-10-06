import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "session-model-")) : undefined
const app = profile ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" },
}) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const page = app ? await app.firstWindow() : await browser.newPage({ viewport: { width: 1440, height: 900 } })
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const editor = () => page.locator(".prompt-box:not([inert]) textarea[aria-label='Message']")
const model = () => page.getByRole("combobox", { name: "Session model" })
const patches = () => fixture.calls.filter(call => call.method === "PATCH" && call.path === "/session/ses_a" && call.body?.model)
const inputs = () => fixture.calls.filter(call => call.method === "POST" && call.path === "/session/ses_a/input")
const prompts = () => fixture.calls.filter(call => call.method === "POST" && call.path === "/session/ses_a/prompt_async")
try {
  await page.goto(preview.url)
  await expect(model()).toBeVisible()
  fixture.holdModel = true
  await model().selectOption("fixture\u0000next")
  await expect.poll(() => patches().length).toBe(1)
  expect(inputs()).toHaveLength(0)
  expect(prompts()).toHaveLength(0)
  await editor().fill("after selecting model")
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeDisabled()
  fixture.holdModel = false
  fixture.modelReplies.shift()()
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Queue", exact: true }).click()
  await expect.poll(() => inputs().length).toBe(1)
  expect(inputs()[0].body.text).toBe("after selecting model")
  expect(prompts()).toHaveLength(0)

  await page.reload()
  await expect(model()).toHaveValue("fixture\u0000next")
  await page.getByRole("button", { name: "Restore saved Aside draft" }).click().catch(() => {})
  fixture.rejectModel = true
  await model().selectOption("fixture\u0000test")
  await expect.poll(() => patches().length).toBe(2)
  await expect(model()).toHaveValue("fixture\u0000next")
  expect(inputs()).toHaveLength(1)
  fixture.rejectModel = false

  const updated = { id: "test", providerID: "fixture", variant: "default" }
  fixture.sessionModels.set("ses_a", updated)
  fixture.emit("session.updated", { sessionID: "ses_a", info: {
    id: "ses_a", title: "Composer fixture", directory, projectID: "fixture", version: "1", agent: "build",
    time: { created: 1, updated: Date.now() + 1000 }, model: updated, preferredModel: updated,
  } })
  await expect(model()).toHaveValue("fixture\u0000test")
  expect(prompts()).toHaveLength(0)

  fixture.loseModel = true
  await model().selectOption("fixture\u0000next")
  await expect.poll(() => patches().length).toBe(3)
  await expect(model()).toHaveValue("fixture\u0000next")
  await page.reload()
  await expect(model()).toHaveValue("fixture\u0000next")
  expect(patches()).toHaveLength(3)
  expect(inputs()).toHaveLength(1)

  fixture.holdModel = true
  await model().selectOption("fixture\u0000test")
  await model().selectOption("fixture\u0000next")
  await expect.poll(() => patches().length).toBe(4)
  fixture.modelReplies.shift()()
  await expect.poll(() => patches().length).toBe(5)
  fixture.holdModel = false
  fixture.modelReplies.shift()()
  await expect(model()).toHaveValue("fixture\u0000next")
  expect(prompts()).toHaveLength(0)
  fixture.setStatus("idle")
  await editor().fill("normal send after selection")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect.poll(() => prompts().length).toBe(1)
  expect(prompts()[0].body.model).toBeUndefined()
} finally {
  await browser?.close()
  await app?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}
