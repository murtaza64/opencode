// macOS Secure Event Input and host tabs (DD #645/#651). One disposable launch (temp profile, mock keychain) with a local
// https page host whose page autofocuses a password field. Reads `ioreg` (read-only) for the session's Secure Input
// owner PID and compares it with this test's own Electron process tree; nothing else is read.
// A) hidden launch (ES_DESKTOP_START=hidden) restored onto the Personal page: is the autofocused password field
//    focused, and does this app own Secure Input?
// B) show the window, focus the password field, switch to the Work tab: is Personal's field still focused, and does
//    this app still own Secure Input while Work is shown? Then back to Personal and blur the field: released?
// ES_SECURE_INPUT_EXPECT=released asserts the defensive fix by activeElement (A: not #pass; B: BODY). ioreg readings
// are context only: a Secure Input owner outside this app (often loginwindow) masks this app's own.
// Run from packages/es-desktop (after `bun run build`), macOS only: node test/secure-input.real.mjs [<packaged executable>]
import { _electron } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const executable = process.argv[2] ?? process.env.ES_DESKTOP_EXECUTABLE
const expectFixed = process.env.ES_SECURE_INPUT_EXPECT === "released"
const profile = await mkdtemp(path.join(tmpdir(), "es-secure-input-profile-"))
const certs = await mkdtemp(path.join(tmpdir(), "es-secure-input-cert-"))
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-days", "1",
  "-keyout", path.join(certs, "key.pem"), "-out", path.join(certs, "cert.pem")], { stdio: "ignore" })
const personal = await new Promise(async (resolve) => {
  const server = createServer({ key: await readFile(path.join(certs, "key.pem")), cert: await readFile(path.join(certs, "cert.pem")) }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end("<!doctype html><title>Sign in fixture</title><form><input id=user name=user><input id=pass name=pass type=password autofocus></form>")
  })
  server.listen(0, "127.0.0.1", () => resolve({ server, origin: `https://127.0.0.1:${server.address().port}` }))
})
const fixture = await createFixture()
const restore = path.join(profile, "restore.json")
await writeFile(restore, JSON.stringify({ version: 1, selected: "personal", views: [{ id: "local", created: true }, { id: "personal", created: true }] }))
// The PID holding Secure Input for this login session, if any (ioreg prints kCGSSessionSecureInputPID).
const secureOwner = () => {
  const out = execFileSync("/usr/sbin/ioreg", ["-l", "-w", "0"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  const match = /"kCGSSessionSecureInputPID"=(\d+)/.exec(out)
  return match ? Number(match[1]) : undefined
}
const tree = (pid) => {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
  const all = new Set([pid])
  for (let grew = true; grew;) { grew = false; for (const [child, parent] of rows) if (all.has(parent) && !all.has(child)) { all.add(child); grew = true } }
  return all
}
const settle = (ms = 1500) => new Promise((resolve) => setTimeout(resolve, ms))
const readings = {}
let electron
try {
  readings.before = secureOwner() ?? null
  electron = await _electron.launch({
    ...(executable ? { executablePath: executable, args: ["--ignore-certificate-errors", "--use-mock-keychain"] } : { args: [root, "--ignore-certificate-errors", "--use-mock-keychain"] }),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "",
      ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RESTORE: restore, ES_DESKTOP_START: "hidden",
      ES_REMOTE_HOSTS: JSON.stringify([{ id: "personal", label: "Personal", origin: personal.origin, mode: "page" }]) },
  })
  const ours = () => tree(electron.process().pid)
  const owned = () => { const pid = secureOwner(); return { pid: pid ?? null, ours: pid !== undefined && ours().has(pid) } }
  let page
  for (let wait = 50; !(page = electron.windows().find((item) => item.url().startsWith(personal.origin))); wait *= 2) {
    if (wait > 20000) throw new Error("no Personal view")
    await settle(wait)
  }
  await page.waitForLoadState("load")
  await settle()
  readings.A_afterLaunch = { ...owned(), activeElement: await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || null) }
  // B: the user opens the window, types into the password field, then switches to Work.
  await electron.evaluate(({ BaseWindow }) => { const window = BaseWindow.getAllWindows()[0]; window.show(); window.focus() })
  await settle()
  await page.bringToFront().catch(() => undefined)
  await page.focus("#pass")
  await settle()
  readings.B_passwordFocused = owned()
  const bar = electron.windows().find((item) => item.url().startsWith("data:text/html"))
  await bar.locator("nav a", { hasText: "Work" }).click()
  await settle()
  readings.B_workShown = { ...owned(), personalActive: await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || null) }
  await bar.locator("nav a", { hasText: "Personal" }).click()
  await settle()
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await settle()
  readings.B_blurred = owned()
  console.log(JSON.stringify(readings))
  if (expectFixed) {
    if (readings.A_afterLaunch.activeElement === "pass") throw new Error("A: the password field is focused after a hidden restore")
    if (readings.B_workShown.personalActive !== "BODY") throw new Error(`B: Personal keeps ${readings.B_workShown.personalActive} focused while Work is shown`)
    if (readings.A_afterLaunch.ours || readings.B_workShown.ours) throw new Error("this app owns Secure Input at a hidden restore or while Work is shown")
    console.log("PASS defensive focus (causality unproven): no focused password field after a hidden restore or while its tab is hidden")
  }
} catch (error) {
  process.exitCode = 1
  console.log(`FAIL ${String(error).split("\n")[0]} ${JSON.stringify(readings)}`)
} finally {
  await electron?.close()
  await fixture.close?.()
  personal.server.close()
  await rm(profile, { recursive: true, force: true })
  await rm(certs, { recursive: true, force: true })
}
