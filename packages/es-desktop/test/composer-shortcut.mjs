import { _electron, expect } from "@playwright/test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createFixture, directory } from "../../es-app/test/composer-fixture.mjs"

const fixture = await createFixture()
const profile = await mkdtemp(path.join(tmpdir(), "es-shortcut-"))
const app = await _electron.launch({
  executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  args: process.env.ES_DESKTOP_EXECUTABLE ? [] : [path.resolve(import.meta.dirname, "..")],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" },
})
try {
  const page = await app.firstWindow()
  await page.waitForURL("http://127.0.0.1:*/")
  await page.goto(`${new URL(page.url()).origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  const target = () => page.locator('.direct-submit-actions [data-keyboard-target="true"]')
  await editor.fill("preserved native draft")
  await editor.evaluate(element => element.setSelectionRange(2, 7))
  if (process.platform === "darwin") {
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.role === "windowmenu").submenu.items.find(item => item.role === "minimize").accelerator)).toBe("")
  }
  await editor.press("Meta+m")
  await expect(target()).toHaveAttribute("aria-label", "Queue")
  await editor.press("Meta+m")
  await expect(target()).toHaveAttribute("aria-label", "Aside")
  await editor.press("Meta+m")
  await expect(target()).toHaveAttribute("aria-label", "Steer")
  await expect(editor).toHaveValue("preserved native draft")
  expect(await editor.evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([2, 7])
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false)
  fixture.setStatus("idle")
  await expect(target()).toHaveAttribute("aria-label", "Send")
  await editor.press("Meta+m")
  await expect(page.locator(".direct-submit-actions button")).toHaveCount(1)
  await expect(editor).toHaveValue("preserved native draft")
  expect(fixture.calls.filter(call => call.method !== "GET")).toEqual([])
  console.log("PASS packaged native Cmd+M: busy cycle, selection/draft preservation, idle Send, no submissions or minimize accelerator")
} finally {
  await app.close()
  await fixture.close()
  await rm(profile, { recursive: true, force: true })
}
