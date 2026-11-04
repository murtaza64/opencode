// Packaged keyboard chords (DD .04.5): the app's any-mode keys reach the page in Electron and View > Reload still works.
// 1. No application-menu item claims Cmd/Ctrl+?, Cmd/Ctrl+/ or F1, and there is no Help-role menu (macOS binds Cmd+? to a
//    Help menu's search field). Reload keeps CommandOrControl+R.
// 2. In the Work view (composer fixture, session page): Cmd+? and F1 open the Keyboard shortcuts dialog; Cmd+/ moves focus
//    into Porter's composer.
// 3. View > Reload reloads the shown Work view.
// Keys go in through Chromium input (CDP), so step 1 is what rules out the OS menu taking them first.
// Run from packages/es-desktop: node test/keyboard-chords.real.mjs [<packaged executable>]
import { _electron, expect } from "@playwright/test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture, directory } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const executable = process.argv[2] ?? process.env.ES_DESKTOP_EXECUTABLE
const profile = await mkdtemp(path.join(tmpdir(), "es-keyboard-chords-"))
const fixture = await createFixture()
const mod = process.platform === "darwin" ? "Meta" : "Control"
const results = []
let app
try {
  app = await _electron.launch({
    ...(executable ? { executablePath: executable, args: ["--use-mock-keychain"] } : { args: [root, "--use-mock-keychain"] }),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" },
  })
  const menu = await app.evaluate(({ Menu }) => {
    const walk = (items) => items.flatMap((item) => [{ label: item.label, role: item.role, accelerator: item.accelerator ?? "" }, ...walk(item.submenu?.items ?? [])])
    return walk(Menu.getApplicationMenu()?.items ?? [])
  })
  const claimed = menu.filter((item) => /^(CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl)\+(Shift\+)?(\/|\?)$|^F1$/i.test(item.accelerator))
  if (claimed.length) throw new Error(`menu claims a chord: ${JSON.stringify(claimed)}`)
  const help = menu.filter((item) => item.role === "help")
  if (help.length) throw new Error(`Help-role menu present: ${JSON.stringify(help)}`)
  const reload = menu.find((item) => item.label === "Reload" || item.role === "reload")
  if (!reload || (reload.label === "Reload" && reload.accelerator !== "CommandOrControl+R")) throw new Error(`Reload item: ${JSON.stringify(reload)}`)
  results.push(`PASS no menu item claims ${mod}+?, ${mod}+/ or F1; no Help-role menu; Reload keeps CommandOrControl+R`)

  const page = await app.firstWindow()
  await page.waitForURL("http://127.0.0.1:*/")
  await page.goto(`${new URL(page.url()).origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await page.getByRole("textbox", { name: "Message", exact: true }).waitFor()
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {})
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" })
  for (const key of [`${mod}+Shift+Slash`, "F1"]) {
    await page.keyboard.press(key)
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden({ timeout: 5_000 })
    results.push(`PASS ${key} opens Keyboard shortcuts in the packaged Work view; Esc closes it`)
  }
  await page.keyboard.press(`${mod}+Slash`)
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".desk-companion")), { timeout: 5_000 }).toBe(true)
  results.push(`PASS ${mod}+/ moves focus into Porter`)

  await page.evaluate(() => { window.__esChordReload = 1 })
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const item = Menu.getApplicationMenu().items.flatMap((top) => top.submenu?.items ?? []).find((entry) => entry.label === "Reload" || entry.role === "reload")
    const window = BrowserWindow.getAllWindows()[0]
    item.click(undefined, window, window?.webContents)
  })
  await page.waitForFunction(() => window.__esChordReload === undefined, undefined, { timeout: 15_000 })
  await page.waitForLoadState("load")
  results.push("PASS View > Reload reloads the Work view")
  if (fixture.calls.some((call) => call.method !== "GET")) throw new Error("a chord wrote to Core")
  results.push("PASS no writes")
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n")[0]}`)
} finally {
  console.log(results.join("\n"))
  await app?.close()
  await fixture.close?.()
  await rm(profile, { recursive: true, force: true })
}
