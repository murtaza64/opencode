import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const assistant = preview.fixture.messages[1]
const command = 'bun run check --directory "/workspace/مرحبا/very-long-project-name/packages/session-ui" --filter "transcript activity rows" ' + "--include=deeply/nested/long-path/".repeat(8)
const filePath = "/workspace/مرحبا/very-long-project-name/packages/session-ui/src/components/transcript-activity.tsx"
const tool = (id, name, input, status = "completed", metadata = {}) => ({
  id, messageID: assistant.info.id, sessionID: "ses_a", type: "tool", tool: name, callID: id,
  state: { status, input, metadata, raw: "{}", title: id, output: "Fixture output: checked successfully", time: { start: 2, end: 3 },
    ...(status === "error" ? { error: "Error: Fixture failure: retry after checking the input" } : {}) },
})
assistant.parts = [
  tool("shell", "bash", { command }),
  tool("patch", "apply_patch", {}, "completed", { files: [
    { filePath, relativePath: filePath, type: "update", before: "old\n", after: "new\n", additions: 1, deletions: 1 },
    { filePath: "/workspace/check.ts", type: "add", before: "", after: "checked\n", additions: 1, deletions: 0 },
  ] }),
  tool("read", "read", { filePath, offset: 20, limit: 40 }),
  tool("grep", "grep", { path: "/workspace/مرحبا", pattern: "activity|transcript" }),
  tool("skill", "skill", { name: "grill-with-docs" }),
  tool("general", "task", { description: "Review keyboard and focus behavior", subagent_type: "general" }, "completed", { sessionId: "ses_child" }),
  tool("explore", "task", { description: "Inspect transcript metadata مرحبا", subagent_type: "explore" }, "running", { sessionId: "ses_child" }),
  tool("pending", "bash", { command: "bun run build" }, "pending"),
  tool("failed", "task", { description: "Check the failure details", subagent_type: "general" }, "error", { sessionId: "ses_child" }),
  tool("single-patch", "apply_patch", {}, "completed", { files: [
    { filePath, type: "update", before: "old\n", after: "new\n", additions: 1, deletions: 1 },
  ] }),
  tool("ordinary", "webfetch", { url: "https://example.com/docs/activity-rows" }),
]
preview.fixture.children.set("ses_child", {
  session: { ...session("ses_child"), parentID: "ses_a", title: "Activity fixture child", directory },
  messages: [{ ...assistant, info: { ...assistant.info, id: "child-message", sessionID: "ses_child" }, parts: assistant.parts.slice(0, 5).map(part => ({ ...part, messageID: "child-message", sessionID: "ses_child" })) }],
  replies: [], closed: 0, hold: "", failure: 0,
})
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "activity-rows-")) : undefined
const app = profile ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "", OPENCODE_URL: preview.fixture.url, ES_DASHBOARD_URL: preview.fixture.url, OPENCODE_SERVER_PASSWORD: "" },
}) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const context = app ? app.context() : await browser.newContext({ viewport: { width: 1440, height: 1100 } })
const page = app ? await app.firstWindow() : await context.newPage()
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const errors = []
page.on("pageerror", error => errors.push(error.message))
const shot = async name => {
  if (process.env.ACTIVITY_SHOTS) await page.screenshot({ path: `${process.env.ACTIVITY_SHOTS}-${name}.png` })
}
const trigger = id => page.locator(`.session-page [data-timeline-part-id="${id}"] [data-slot="collapsible-trigger"]`).first()
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  await expect(trigger("general")).toBeVisible()
  await page.evaluate(() => {
    const output = document.createElement("output")
    output.id = "copy-capture"
    output.hidden = true
    document.body.append(output)
    document.addEventListener("copy", event => {
      event.preventDefault()
      output.textContent = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement.value : document.getSelection().toString()
    })
  })
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Fixture draft preserved")
  await page.locator(".session-page .transcript").evaluate(el => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 0 })
  await shot("desktop")
  const before = process.env.ACTIVITY_BEFORE === "1"
  if (!before) {
    await expect(trigger("general")).toContainText("Agent")
    await expect(trigger("explore")).toContainText("Explore")
    await expect(page.locator('[data-tool="skill"] [data-slot="basic-tool-tool-subtitle"]')).toHaveText("grill-with-docs")
    await trigger("shell").focus()
    await page.keyboard.press("Enter")
    await expect(trigger("shell")).toHaveAttribute("aria-expanded", "true")
    await expect(page.locator('[data-slot="bash-pre"]').first()).toHaveText(`$ ${command}\n\nFixture output: checked successfully`)
    await page.locator('[data-slot="bash-copy"] button').first().click()
    expect(await page.locator("#copy-capture").textContent()).toBe(`$ ${command}\n\nFixture output: checked successfully`)
    await page.locator('[data-slot="bash-scroll"]').first().focus()
    expect(await page.locator('[data-slot="bash-scroll"]').first().evaluate(el => getComputedStyle(el).userSelect)).not.toBe("none")
    await shot("expanded")
    await trigger("shell").click()
    const group = page.locator('[data-component="context-tool-group-trigger"]').first()
    await group.click()
    await expect(page.locator('[data-component="context-tool-group-list"]').first()).toContainText(filePath)
    await shot("group")
    await group.click()
    await trigger("patch").click()
    await expect(trigger("single-patch")).toContainText(filePath)
    await expect(page.locator('[data-slot="apply-patch-filename"]').first()).toBeVisible()
    await trigger("patch").click()
    await trigger("pending").click()
    await expect(trigger("pending")).toHaveAttribute("aria-expanded", "true")
    await trigger("pending").click()
    await trigger("failed").focus()
    await trigger("failed").press("Enter")
    await expect(page.locator('[data-slot="tool-error-card-content"]')).toContainText("retry after checking the input")
    await trigger("failed").press("Enter")
  }
  const saved = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith("es-app:composer:"))))
  await trigger("general").focus()
  const scroll = await page.locator(".session-page .transcript").evaluate(el => el.scrollTop)
  await page.keyboard.press("Enter")
  await expect(page.getByRole("dialog")).toContainText("Activity fixture child")
  if (!before) {
    await page.getByRole("dialog").locator('[data-tool="bash"] [data-slot="collapsible-trigger"]').click()
    await expect(page.getByRole("dialog").locator('[data-slot="bash-pre"]')).toContainText(command)
    await page.getByRole("dialog").locator('[data-slot="bash-copy"] button').click()
    expect(await page.locator("#copy-capture").textContent()).toBe(`$ ${command}\n\nFixture output: checked successfully`)
  }
  await shot("modal")
  await page.keyboard.press("Escape")
  await expect(trigger("general")).toBeFocused()
  expect(await page.locator(".session-page .transcript").evaluate(el => el.scrollTop)).toBe(scroll)
  expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith("es-app:composer:"))))).toEqual(saved)
  for (const dir of ["ltr", "rtl"]) {
    await page.setViewportSize({ width: 390, height: 1000 })
    await page.evaluate(dir => { document.documentElement.dir = dir }, dir)
    await page.locator(".session-page .transcript").evaluate(el => { el.scrollTop = 0 })
    await shot(`mobile-${dir}`)
    if (!before) {
      const size = await page.locator(".session-page .transcript").evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }))
      expect(size.scroll).toBeLessThanOrEqual(size.client)
      await trigger("shell").click()
      const body = page.locator('[data-slot="bash-scroll"]').first()
      await expect(body).toBeVisible()
      expect(await body.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      await shot(`expanded-${dir}`)
      await trigger("shell").click()
    }
  }
  expect(preview.fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  expect(errors).toEqual([])
  console.log("PASS activity rows: fixture screenshots, command details, groups, patch, pending/error, modal keyboard/focus/drafts/scroll, mobile/RTL containment, zero mutations")
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}
