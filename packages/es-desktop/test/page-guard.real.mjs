// Personal-view restart baseline (page-guard.ts): a private profile, a self-signed local https page host and the
// fixture Core. The page restores its own draft and a sessionStorage key on load. Reads go through the view's isolated
// world as a publisher would (executeJavaScriptInIsolatedWorld 999 -> __esPageGuard.read()). Cases: self-restore (no
// loss), typing after load, input before the load settled, clearing and removal, navigation reset, late async restore;
// and the page's own window gains no globals.
// Run from packages/es-desktop: node test/page-guard.real.mjs [<packaged Editspace executable>]
import { _electron, expect } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const executable = process.argv[2] ?? process.env.ES_DESKTOP_EXECUTABLE
const profile = await mkdtemp(path.join(tmpdir(), "es-page-guard-profile-"))
const certs = await mkdtemp(path.join(tmpdir(), "es-page-guard-cert-"))
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-days", "1",
  "-keyout", path.join(certs, "key.pem"), "-out", path.join(certs, "cert.pem")], { stdio: "ignore" })
const PAGE = `<!doctype html><title>Personal fixture</title>
<script>window.__namesAtStart = Object.getOwnPropertyNames(window)</script>
<textarea id="note" name="note"></textarea><input id="title" name="title"><input type="checkbox" id="done" name="done"><select id="pick" name="pick"><option value="a">A</option><option value="b">B</option></select>
<script>
  if (!localStorage.getItem("draft")) localStorage.setItem("draft", "draft the page restored")
  document.getElementById("note").value = localStorage.getItem("draft")
  sessionStorage.setItem("tab", "1")
  if (location.search.includes("late")) setTimeout(() => { document.getElementById("title").value = "restored late" }, 3000)
</script>`
const personal = await new Promise(async (resolve) => {
  const server = createServer({ key: await readFile(path.join(certs, "key.pem")), cert: await readFile(path.join(certs, "cert.pem")) }, (req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end(PAGE)
  })
  server.listen(0, "127.0.0.1", () => resolve({ server, origin: `https://127.0.0.1:${server.address().port}` }))
})
const fixture = await createFixture()
const restore = path.join(profile, "restore.json")
await writeFile(restore, JSON.stringify({ version: 1, selected: "personal", views: [{ id: "personal", created: true }] }))
const electron = await _electron.launch({
  ...(executable ? { executablePath: executable, args: ["--ignore-certificate-errors", "--use-mock-keychain"] } : { args: [root, "--ignore-certificate-errors", "--use-mock-keychain"] }),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "",
    ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden", ES_DESKTOP_RESTORE: restore,
    ES_REMOTE_HOSTS: JSON.stringify([{ id: "personal", label: "Personal", origin: personal.origin, mode: "page" }]) },
})
const results = {}
const settle = () => new Promise((resolve) => setTimeout(resolve, 2600))
try {
  let page
  for (let wait = 50; !(page = electron.windows().find((item) => item.url().startsWith(personal.origin))); wait *= 2) {
    if (wait > 20000) throw new Error(`no Personal view: ${electron.windows().map((item) => item.url())}`)
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
  await page.waitForLoadState("load")
  const read = () => electron.evaluate(({ webContents }, origin) => {
    const contents = webContents.getAllWebContents().find((item) => item.getURL().startsWith(origin))
    return contents.executeJavaScriptInIsolatedWorld(999, [{ code: "globalThis.__esPageGuard ? globalThis.__esPageGuard.read() : null" }])
  }, personal.origin)

  // 1. Self-restore: the draft and the sessionStorage key came from the page itself. Nothing to lose.
  await settle()
  results.selfRestore = await read()
  // A renderer-CDP publisher reaches the same world: the top frame's isolated context named "Electron Isolated Context".
  const cdp = await page.context().newCDPSession(page)
  const contexts = []
  cdp.on("Runtime.executionContextCreated", (event) => contexts.push(event.context))
  await cdp.send("Runtime.enable")
  const top = (await cdp.send("Page.getFrameTree")).frameTree.frame.id
  const isolated = contexts.filter((context) => context.auxData?.frameId === top && context.auxData?.type === "isolated" && context.name === "Electron Isolated Context")
  expect(isolated.length).toBe(1)
  const viaCDP = await cdp.send("Runtime.evaluate", { contextId: isolated[0].id, expression: "globalThis.__esPageGuard ? globalThis.__esPageGuard.read() : null", returnByValue: true })
  results.cdp = { contexts: contexts.map((context) => ({ name: context.name, type: context.auxData?.type, top: context.auxData?.frameId === top })), sameAsNative: JSON.stringify(viaCDP.result.value) === JSON.stringify(results.selfRestore), generationType: typeof viaCDP.result.value?.generation }
  expect(results.cdp.sameAsNative).toBe(true)
  await cdp.detach()
  expect(results.selfRestore).toMatchObject({ version: 1, valid: true, interacted: false, fieldsAdded: 0, fieldsChanged: 0, fieldsRemoved: 0, ssAdded: 0, ssChanged: 0, ssRemoved: 0 })
  expect(JSON.stringify(results.selfRestore)).not.toContain("127.0.0.1")
  expect(JSON.stringify(results.selfRestore)).not.toContain("note")

  // 2. Typing after the load settled counts.
  await page.locator("#title").pressSequentially("typed after load")
  results.typedAfter = await read()
  expect(results.typedAfter).toMatchObject({ valid: true, interacted: true, fieldsChanged: 1 })

  // A checkbox and a select changed by the person count too.
  await page.locator("#done").check()
  await page.locator("#pick").selectOption("b")
  results.controls = await read()
  expect(results.controls).toMatchObject({ valid: true, fieldsChanged: 3 })

  // 4. Clearing the restored draft and the page dropping its key both count.
  await page.locator("#note").fill("")
  await page.evaluate(() => sessionStorage.removeItem("tab"))
  results.cleared = await read()
  expect(results.cleared).toMatchObject({ valid: true, fieldsChanged: 4, ssRemoved: 1 })

  // 5. Navigation resets: a new document has no baseline until it settles, then starts clean; a same-document URL
  // change invalidates the baseline.
  const before = results.cleared.generation
  await page.goto(`${personal.origin}/?n=2`)
  results.navigated = await read()
  expect(results.navigated).toMatchObject({ valid: false, reason: "not-settled" })
  expect(results.navigated.generation).not.toBe(before)
  await settle()
  results.navigatedSettled = await read()
  expect(results.navigatedSettled).toMatchObject({ valid: true, fieldsChanged: 0, ssAdded: 0 })
  await page.evaluate(() => history.pushState({}, "", "/elsewhere"))
  results.pushState = await read()
  expect(results.pushState).toMatchObject({ valid: false, reason: "navigated", urlMatch: false })

  // 3. Input before the load settled: no baseline is ever taken for this document.
  await page.goto(`${personal.origin}/?n=3`)
  await page.locator("#title").pressSequentially("early")
  await settle()
  results.earlyInput = await read()
  expect(results.earlyInput).toMatchObject({ valid: false, reason: "interacted", fieldsChanged: 0 })

  // 6. A restore that lands after the baseline counts (holds, fail-closed).
  await page.goto(`${personal.origin}/?late`)
  await new Promise((resolve) => setTimeout(resolve, 4000))
  results.lateRestore = await read()
  expect(results.lateRestore).toMatchObject({ valid: true, interacted: false, fieldsChanged: 1 })

  // The page's own window: no guard global, and the same own properties as the page loaded without the preload.
  const names = await page.evaluate(() => ({ guard: typeof globalThis.__esPageGuard, names: window.__namesAtStart }))
  const plain = await electron.evaluate(async ({ BrowserWindow }, url) => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, partition: "page-guard-plain" } })
    await window.loadURL(url)
    const value = await window.webContents.executeJavaScript("window.__namesAtStart")
    window.destroy()
    return value
  }, `${personal.origin}/?plain`)
  results.globals = { guard: names.guard, extra: names.names.filter((name) => !plain.includes(name)), missing: plain.filter((name) => !names.names.includes(name)) }
  expect(results.globals).toEqual({ guard: "undefined", extra: [], missing: [] })
  console.log(JSON.stringify(results, null, 2))
  console.log("PASS page guard: self-restore 0, typed after load counts, checkbox/select count, clear/removal count, navigation resets (new document + pushState), input before settle UNKNOWN, late restore counts; no page-visible globals")
} finally {
  await electron.close()
  await fixture.close?.()
  personal.server.close()
  await rm(profile, { recursive: true, force: true })
  await rm(certs, { recursive: true, force: true })
}
