import { createRequire } from "node:module"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "model-picker-")) : undefined
const app = profile ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE, args: ["--use-mock-keychain"],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "", OPENCODE_URL: preview.fixture.url, ES_DASHBOARD_URL: preview.fixture.url, OPENCODE_SERVER_PASSWORD: "" },
}) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const page = app ? await app.firstWindow() : await browser.newPage({ viewport: { width: 1440, height: 900 } })
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
  await page.setViewportSize({ width: 1440, height: 900 })
}
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
await page.route("**/config/providers*", route => route.fulfill({ json: { default: { fixture: "test" }, providers: [
  { id: "fixture", name: "Fixture", models: { test: { name: "Fixture model", capabilities: { input: { image: true } } }, next: { name: "Next model", capabilities: { input: { image: false } } } } },
  { id: "openrouter", name: "OpenRouter", models: {
    "openrouter/auto": { name: "Auto Router", capabilities: { input: { image: true } } },
    "openai/gpt-6.1-sol": { name: "GPT-6.1 Sol", release_date: "2026-09-29", capabilities: { input: { image: true } } },
    "openai/gpt-6.2-sol": { name: "GPT-6.2 Sol", release_date: "2026-11-17", capabilities: { input: { image: true } } },
    "anthropic/claude-opus-5.5": { name: "Claude Opus 5.5", release_date: "2026-09-22", capabilities: { input: { image: true } } },
    ...Object.fromEntries(Array.from({ length: 350 }, (_, i) => [`vendor/model-${i}`, { name: `Catalog model ${i}` }])),
  } },
  { id: "other", name: "Other provider", models: { "مثال-long-id": { name: "نموذج Example", capabilities: { input: { image: true } } } } },
] } }))
const dialog = () => page.getByRole("dialog", { name: "Session model", exact: true })
const search = () => page.getByRole("combobox", { name: "Search models" })
const change = () => page.getByRole("button", { name: /^Change model/ })
const editor = () => page.locator('.prompt-box textarea[aria-label="Message"]')
const writes = () => preview.fixture.calls.filter(call => call.method !== "GET" && /\/session\/ses_a(?:\/(?:input|prompt_async|aside))?$/.test(call.path))
await mkdir("artifacts/model-picker", { recursive: true })
try {
  await page.goto(preview.url)
  await editor().fill("Keep this draft and selection")
  await editor().evaluate(el => el.setSelectionRange(5, 10))
  await change().click()
  await expect(search()).toBeFocused()
  await expect(dialog().getByRole("option").first()).toContainText("Fixture model")
  await expect(dialog().getByRole("option").filter({ hasText: "Quick pick" })).toHaveCount(3)
  await search().fill("openrouter sol 6.2")
  await expect(dialog().getByRole("option")).toHaveCount(1)
  await search().press("Meta+Enter")
  await expect(dialog()).toHaveCount(0)
  await expect.poll(() => preview.fixture.sessionModels.get("ses_a")?.id).toBe("openai/gpt-6.2-sol")
  expect(writes()).toHaveLength(1)
  await expect(editor()).toHaveValue("Keep this draft and selection")
  expect(await editor().evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([5, 10])
  await expect(change()).toBeEnabled()
  await change().click()
  await dialog().getByRole("button", { name: "Other provider", exact: true }).click()
  await expect(dialog().getByRole("option")).toHaveCount(1)
  await expect(dialog().getByRole("option")).toContainText("نموذج Example")
  await dialog().getByRole("button", { name: "All providers", exact: true }).click()
  await dialog().getByRole("checkbox", { name: "Image input" }).check()
  await expect(dialog().getByRole("option")).toHaveCount(6)
  await search().fill("no such model")
  await expect(dialog()).toContainText("No matching models")
  await search().press("Enter")
  expect(writes()).toHaveLength(1)
  await search().press("Escape")
  await expect(change()).toBeFocused()
  await change().click()
  await search().press("ArrowDown")
  await search().press("ArrowUp")
  expect(await search().getAttribute("aria-activedescendant")).toMatch(/option-0$/)
  await page.screenshot({ path: "artifacts/model-picker/desktop.png" })
  await search().press("Tab")
  expect(await dialog().evaluate(el => el.contains(document.activeElement))).toBe(true)
  await search().press("Escape")
  await expect(dialog()).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { document.documentElement.dir = "rtl"; document.documentElement.lang = "ar" })
  await change().click()
  await search().fill("Example")
  await expect(dialog().getByRole("option")).toHaveCount(1)
  const geometry = await dialog().evaluate(el => ({ width: el.getBoundingClientRect().width, scroll: el.scrollWidth, client: el.clientWidth, height: el.getBoundingClientRect().height, dir: getComputedStyle(el).direction }))
  expect(geometry.dir).toBe("rtl")
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.client)
  expect(geometry.width).toBeLessThanOrEqual(390)
  expect(geometry.height).toBeLessThanOrEqual(812)
  await page.screenshot({ path: "artifacts/model-picker/phone-rtl.png" })
  await search().press("Escape")
  await expect(dialog()).toHaveCount(0)
  expect(writes()).toHaveLength(1)
  const image = await page.screenshot({ clip: { x: 0, y: 0, width: 24, height: 24 } })
  await editor().evaluate((el, data) => {
    const files = new DataTransfer()
    files.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], "kept.png", { type: "image/png" }))
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: files }))
  }, image.toString("base64"))
  await expect(page.getByRole("button", { name: "Remove kept.png", exact: true })).toBeVisible()
  await change().click()
  await search().fill("next")
  await search().press("Enter")
  await expect(page.getByText("Selected model does not support image input. Images and session model were not changed.", { exact: true })).toBeVisible()
  expect(writes()).toHaveLength(1)
  await expect(page.getByRole("button", { name: "Remove kept.png", exact: true })).toBeVisible()
  await expect(editor()).toHaveValue("Keep this draft and selection")
  await page.evaluate(() => {
    for (const storage of [sessionStorage, localStorage]) {
      for (const key of Object.keys(storage).filter(key => key.startsWith("es-app:composer:1:"))) {
        const value = JSON.parse(storage.getItem(key))
        value.aside = { text: "Aside draft", images: [], model: null, selection: [0, 0], revision: 0 }
        value.visibleBuffer = "aside"
        value.directView = 1
        value.asideSeeded = true
        storage.setItem(key, JSON.stringify(value))
      }
    }
  })
  await page.reload()
  await expect(editor()).toHaveValue("Aside draft")
  await change().click()
  await search().fill("next")
  await search().press("Enter")
  expect(writes()).toHaveLength(1)
  await expect(page.locator(".direct-model-name")).toHaveText("Next model")
  await change().click()
  await page.getByRole("option", { name: /^Use session model/ }).click()
  await expect(page.locator(".direct-model-name")).not.toHaveText("Next model")
  expect(writes()).toHaveLength(1)
  expect(errors).toEqual([])
  console.log("PASS: search, provider/image filters, catalog quick picks, keyboard, cancel/focus, draft/selection, no prompt submission, desktop and narrow RTL")
} finally { await browser?.close(); await app?.close(); await preview.close(); if (profile) await rm(profile, { recursive: true, force: true }) }
