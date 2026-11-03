// surface-owner-feedback: a Surface header names its owning lane (resolved to that lane's current owner session on the
// Surface's host) and who published it; Message owner opens that session with the Surface as a context chip in its
// draft (its draft text kept, nothing sent); a Surface without a current owner offers Ask Front Desk with the same
// chip. Also another Work host's Surface. Fake dashboard rows; the composer fixture serves the sessions.
// Run from packages/es-app: node test/surface-owner.browser.mjs
import { mkdir } from "node:fs/promises"
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect: base } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const expect = base.configure({ timeout: 30_000 })
const artifacts = new URL("../artifacts/surface-owner/", import.meta.url)
await mkdir(artifacts, { recursive: true })
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
// The Front desk chat is a ready session (ses_b), as in ask-about.browser.
await context.addInitScript((value) => { try { localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) } catch {} }, { session: "ses_b", directory })
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const miniOrigin = "http://127.0.0.1:65033"
// The fixture page's project is "fixture"; another host's Surfaces are listed for the same project.
const row = (id, lane, owner) => ({ id, title: `${id} research`, summary: "Findings", kind: "path", owner, lane, editspace: "fixture",
  updated_at: Date.now(), revision: 1, health: { state: "ok" }, purpose: "board" })
const local = [row("granola", "granola-research", "Relay"), row("orphan", "gone-lane", "gone-lane")]
// This host: the granola lane was handed off; its record names the successor (ses_a, the fixture's session).
const localState = { editspace: "fixture", threads: [{ sessions: [], tickets: [], lanes: [{ lane: "granola-research", owner: "ses_a" }] }], sessions: [{ id: "ses_a", directory }, { id: "ses_old", directory }] }
await page.route((url) => new URL(url).origin === miniOrigin, (route) => route.abort())
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.origin }, { id: "mini", label: "Mac Mini", origin: miniOrigin }] } }))
await page.route((url) => { const u = new URL(url); return u.origin === preview.origin && u.pathname === "/es/api/surfaces" }, (route) => route.fulfill({ json: { surfaces: local } }))
await page.route((url) => { const u = new URL(url); return u.origin === preview.origin && u.pathname === "/es/api/state" }, (route) => route.fulfill({ json: localState }))
await page.route((url) => /\/__es\/surface\/[^/]+$/.test(new URL(url).pathname), (route) => route.fulfill({ json: { src: "about:blank" } }))
// The Mac Mini: one Surface whose lane is owned there by ses_m.
await page.route("**/hosts/mini/**", (route) => {
  const path = new URL(route.request().url()).pathname.replace(/^\/hosts\/mini/, "")
  if (path === "/es/api/surfaces") return route.fulfill({ json: { surfaces: [row("granola", "granola-research", "granola-research")] } })
  if (path === "/es/api/state") return route.fulfill({ json: { editspace: "fixture", threads: [{ sessions: [], tickets: [], lanes: [{ lane: "granola-research", owner: "ses_m" }] }], sessions: [{ id: "ses_m", directory: "/mini/lanes/granola" }] } })
  if (path === "/oc/experimental/session") return route.fulfill({ json: [] })
  if (path === "/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: "/mini" }], default: "fixture" } })
  if (path === "/__es/surface/granola") return route.fulfill({ json: { src: "about:blank" } })
  return route.fulfill({ status: 404, json: {} })
})
const head = page.locator(".surface-head")
const results = []
const step = (name) => results.push(`PASS ${name}`)
try {
  // A draft already in the owner's session.
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  const editor = page.locator("textarea").first()
  await editor.fill("my earlier draft")
  await page.goto(`${preview.origin}/?item=${encodeURIComponent("surface:granola")}`, { waitUntil: "domcontentloaded" })
  await expect(head.locator(".surface-owner")).toContainText("Owner: granola-research")
  await expect(head.locator(".surface-owner")).toContainText("Published by Relay")
  await page.screenshot({ path: new URL("owner.png", artifacts).pathname })
  await head.getByRole("button", { name: "Message owner" }).click()
  await expect(page).toHaveURL(new RegExp(`/session/ses_a\\?directory=`))
  await expect(page.locator(".context-chip[data-kind=surface]")).toContainText("granola research")
  await expect(page.locator("textarea").first()).toHaveValue("my earlier draft")
  step("owner resolved through the handoff (lane record -> current session); publisher shown; Message owner opens it with the Surface chip, draft kept, nothing sent")

  await page.goto(`${preview.origin}/?item=${encodeURIComponent("surface:orphan")}`, { waitUntil: "domcontentloaded" })
  await expect(head.locator(".surface-owner")).toContainText("lane gone-lane not found")
  await expect(head.getByRole("button", { name: "Message owner" })).toHaveCount(0)
  await head.getByRole("button", { name: "Ask Front Desk" }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("es-app:context-refs:ses_b") ?? "")).toContain('"id":"orphan"')
  await expect(page.locator(".desk-chat .context-chip[data-kind=surface]")).toContainText("orphan research")
  step("no current owner: says why and Ask Front Desk opens the Front desk with the same chip")

  await page.goto(`${preview.origin}/?item=${encodeURIComponent("mini~surface:granola")}`, { waitUntil: "domcontentloaded" })
  await expect(head.locator(".surface-owner")).toContainText("Owner: granola-research")
  await expect(head.locator(".surface-owner")).not.toContainText("Published by")
  await head.getByRole("button", { name: "Message owner" }).focus()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/session\/ses_m\?directory=%2Fmini%2Flanes%2Fgranola&host=mini/)
  const chips = await page.evaluate(() => localStorage.getItem("es-app:context-refs:mini:ses_m"))
  if (!chips?.includes('"host":"mini"')) throw new Error(`remote chip ${chips}`)
  step("another host's Surface: owner on that host, opened there (keyboard) with a host-qualified chip")

  await page.goto(`${preview.origin}/?item=${encodeURIComponent("surface:granola")}`, { waitUntil: "domcontentloaded" })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await expect(head.locator(".surface-owner")).toBeVisible()
  await page.screenshot({ path: new URL("owner-rtl.png", artifacts).pathname })
  step("RTL header renders")
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`)
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n")[0]}`)
} finally {
  console.log(results.join("\n"))
  await browser.close()
  await preview.close()
}
