// Laptop2677: in the real Electron window the session title starts at the pane's text edge, never centred in a reserved
// column. Measured with the desktop's own header CSS, without and with the native host-tab strip (the CSS tabs.ts
// inserts), at 1440 and 900. Disposable fixture, temp profile, mock keychain. Run from packages/es-desktop after
// `bun run build`, or against a packaged app: ES_DESKTOP_EXECUTABLE=<Editspace.app/Contents/MacOS/Editspace>.
import { _electron } from "@playwright/test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createFixture, directory } from "../../es-app/test/composer-fixture.mjs"

const fixture = await createFixture()
const profile = await mkdtemp(path.join(tmpdir(), "editspace-header-title-"))
const executable = process.env.ES_DESKTOP_EXECUTABLE
const app = await _electron.launch({ executablePath: executable, args: executable ? ["--use-mock-keychain"] : [path.resolve(import.meta.dirname, ".."), "--use-mock-keychain"],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "" } })
let failed = false
try {
  const page = await app.firstWindow()
  await page.waitForURL("http://127.0.0.1:*/")
  await page.goto(`${new URL(page.url()).origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 120_000 })
  await page.waitForSelector(".native-header .session-title", { timeout: 120_000 })
  const measure = () => page.evaluate(() => {
    const main = document.querySelector(".session-main")
    const toggle = document.querySelector(".native-header-project").getBoundingClientRect()
    return { title: document.querySelector(".native-header .session-title").getBoundingClientRect().left, header: document.querySelector(".native-header-safe").getBoundingClientRect().left,
      toggleLeft: toggle.left, toggleWidth: toggle.width, gap: parseFloat(getComputedStyle(document.querySelector(".native-header-safe")).columnGap),
      text: main.getBoundingClientRect().left + parseFloat(getComputedStyle(main).paddingInlineStart) }
  })
  const resize = width => app.evaluate(({ BrowserWindow }, width) => { const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ ...window.getBounds(), width }) }, width)
  for (const [name, width, strip] of [["wide", 1440, 0], ["narrow", 900, 0], ["tabs wide", 1440, 296], ["tabs narrow", 900, 296]]) {
    await resize(width)
    // The same rule the desktop inserts for its native host tabs (tabs.ts inset).
    if (strip) await app.evaluate(({ BrowserWindow }, css) => BrowserWindow.getAllWindows()[0].webContents.insertCSS(css), `:root{--host-tabs-end:${strip}px}.native-header-safe{left:max(84px,${strip}px)!important}`)
    await page.waitForTimeout(800)
    const at = await measure()
    // At the text edge when the header reaches it; otherwise right after the sidebar toggle, never further in.
    const expected = Math.max(at.text, at.toggleLeft + 28 + at.gap)
    assert(Math.abs(at.title - expected) <= 2, `${name}: title at ${at.title}, expected ${expected} (text ${at.text}, header ${at.header}, column ${at.toggleWidth})`)
    console.log(`PASS ${name}: title ${Math.round(at.title)} · text ${Math.round(at.text)} · header starts ${Math.round(at.header)}`)
  }
} catch (error) {
  failed = true
  console.error(error)
} finally {
  await app.close().catch(() => {})
  await rm(profile, { recursive: true, force: true })
}
if (failed) process.exit(1)
console.log("PASS header-title")
process.exit(0)
