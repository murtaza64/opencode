// Desk2814 S3: another Work host's requested deliverable is a Try row in this window's Needs you, and seen/unread in its
// reader change only that host's seen state. Two real dashboard Surface stores (src/fixtures/surfaces-host.py over
// dotfiles bin/es_dashboard_surfaces.py): this host's and the Mini's, each with the same deliverable id. The page's
// /es/api routes go to the local store and /hosts/mini/es/api routes to the Mini's, each with its own operator cookie
// (the Mini's is minted by the Mini's own operator flow, as the Local listener does). Disposable fixture.
// Run from packages/es-app: node test/remote-deliverable-done.browser.mjs
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")

// One real Surface store per host, publishing from `editspace`; `send` reaches it the way that host's listener does
// (its own origin and its own operator cookie jar).
const storeHost = async (editspace) => {
  const home = await mkdtemp(path.join(tmpdir(), "es-surfaces-host-"))
  const child = spawn("uv", ["run", "--script", fileURLToPath(new URL("../src/fixtures/surfaces-host.py", import.meta.url))], {
    env: { ...process.env, HOME: home, ES_FIXTURE_EDITSPACE: editspace, DOTFILES_BIN: process.env.DOTFILES_BIN ?? path.join(homedir(), "dotfiles/bin"), UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? path.join(homedir(), ".cache/uv") },
    stdio: ["ignore", "pipe", "inherit"],
  })
  const origin = `http://127.0.0.1:${(await new Promise((resolve) => child.stdout.once("data", resolve))).toString().trim()}`
  for (let wait = 50; !(await fetch(`${origin}/api/surfaces`).then((response) => response.status < 500, () => false)); wait *= 2) await new Promise((resolve) => setTimeout(resolve, wait))
  const jar = new Map()
  const send = async (pathname, init = {}) => {
    const headers = { ...init.headers, origin, ...(jar.size ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") } : {}) }
    const response = await fetch(`${origin}${pathname}`, { ...init, headers })
    for (const cookie of response.headers.getSetCookie()) { const [name, value] = cookie.split(";")[0].split("="); jar.set(name, value) }
    return response
  }
  const publish = async (summary, id = "report", title = "API tests") =>
    (await (await fetch(`${origin}/__fixture/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title, summary }) })).json()).revision
  return { send, publish, home, close: async () => { child.kill(); await rm(home, { recursive: true, force: true }) } }
}

const local = await storeHost("opencode")
const mini = await storeHost("fixture")
// This host's page already has an operator session; the Mini's is set up by the page through the Mini's own flow.
await local.send("/api/attention/session", { method: "POST", headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: "{}" })
const seenOn = async (store, id = "report") => (await (await store.send("/api/surfaces")).json()).surfaces.find((item) => item.id === id)?.seen

const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(30_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const miniOrigin = "http://127.0.0.1:65032"
const writes = { local: [], mini: [] }
let mintDown = true
const results = []
// The Mini's "live" deliverable reads as a link surface (served only on the Mini), which this window cannot frame.
const asLink = (pathname, body) => pathname !== "/api/surfaces" ? body
  : JSON.stringify({ ...JSON.parse(body), surfaces: JSON.parse(body).surfaces.map((item) => item.id === "live" ? { ...item, kind: "url" } : item) })
const forward = async (route, store, pathname, rewrite = (_pathname, body) => body) => {
  const request = route.request()
  const init = request.method() === "GET" ? {} : { method: request.method(), body: request.postData() ?? undefined,
    headers: { "content-type": "application/json", "X-Attention-CSRF": request.headers()["x-attention-csrf"] ?? "" } }
  const response = await store.send(pathname, init).catch(() => undefined)
  if (!response) return route.abort("connectionreset")
  return route.fulfill({ status: response.status, contentType: "application/json", body: rewrite(pathname, await response.text()) })
}
await page.context().route((url) => new URL(url).origin === miniOrigin, (route) => route.fulfill({ contentType: "text/html", body: "<title>Mini</title>" }))
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.origin }, { id: "mini", label: "Mac Mini", origin: miniOrigin }] } }))
await page.route((url) => new URL(url).pathname.startsWith("/hosts/mini/"), (route) => {
  const url = new URL(route.request().url())
  const pathname = url.pathname.replace(/^\/hosts\/mini/, "")
  if (route.request().method() !== "GET") writes.mini.push(`${route.request().method()} ${pathname} ${route.request().postData() ?? ""}`)
  if (pathname === "/es/api/surfaces" || pathname === "/es/api/attention/session" || pathname === "/es/api/frontdesk/deliverables/seen")
    return forward(route, mini, pathname.replace(/^\/es/, ""), asLink)
  if (pathname === "/__es/surface/report") return mintDown ? route.fulfill({ status: 502, contentType: "text/plain", body: "down" }) : route.fulfill({ json: { src: "about:blank" } })
  if (pathname === "/oc/experimental/session") return route.fulfill({ json: [] })
  if (pathname === "/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: "/Users/mini/fixture/.editspace" }], default: "fixture" } })
  if (pathname === "/es/api/attention" && route.request().method() === "GET") return route.fulfill({ json: { records: [], projects: [{ editspace: "fixture", available: true }], partial: false, limit: 200,
    inputs: { schema: "needs-you-inputs/1", boot: "b", rev: 1, requests: [], failures: [], ignores: [], deliverables: [],
      sources: Object.fromEntries(["requests", "failures", "ignores", "deliverables"].map((name) => [name, { checked_at: Date.now(), ok: true }])) } } })
  if (pathname === "/oc/global/event") return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": ok\n\n" })
  return route.fulfill({ status: 404, json: { error: "not in this fixture" } })
})
await page.route((url) => { const u = new URL(url); return u.origin === preview.origin && ["/es/api/surfaces", "/es/api/frontdesk/deliverables/seen"].includes(u.pathname) }, (route) => {
  const pathname = new URL(route.request().url()).pathname
  if (route.request().method() !== "GET") writes.local.push(`${route.request().method()} ${pathname}`)
  return forward(route, local, pathname.replace(/^\/es/, ""))
})
await page.route((url) => new URL(url).pathname === "/__es/surface/report", (route) => route.fulfill({ json: { src: "about:blank" } }))

const band = page.locator("nav.sidebar section.needs-you-band")
const localRow = band.locator("[data-nav-item='surface:report']")
const miniRow = band.locator("[data-nav-item='mini~surface:report']")
const reader = page.locator(".surface-head")
const step = (name) => results.push(`PASS ${name}`)
try {
  await local.publish("local first")
  await mini.publish("mini first")
  await mini.publish("board", "live", "Live board")
  await page.goto(`${preview.origin}/`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(miniRow).toHaveAttribute("aria-label", "Try · API tests · Fixture lead · rev 1 · on Mac Mini", { timeout: 60_000 })
  await expect(localRow).toHaveAttribute("aria-label", "Try · API tests · Fixture lead · rev 1")
  await expect(miniRow.locator(".host-glyph, [data-host]").first()).toBeAttached()
  step("the same deliverable on this host and the Mini is two Try rows; the Mini's names its host")

  await miniRow.click()
  await expect(page).toHaveURL(`${preview.origin}/?item=${encodeURIComponent("mini~surface:report")}`)
  await reader.locator(".surface-owner-chip").click()
  await expect(reader.locator(".surface-owner-meta").first()).toContainText("Mac Mini")
  await reader.locator(".surface-owner-chip").click()
  // Nothing on screen yet (the frame address failed): nothing is marked.
  await expect(page.locator(".work-remote-surface [role=alert]")).toContainText("Cannot open this surface")
  await page.waitForTimeout(1_000)
  if (writes.mini.some((item) => item.includes("deliverables/seen"))) throw new Error("a failed frame marked seen")
  mintDown = false
  await page.locator(".work-remote-surface").getByRole("button", { name: "Try again" }).click()
  await expect(page.locator(".work-remote-surface iframe")).toBeAttached()
  step("a failed Mini frame marks nothing")
  await expect(reader.locator(".surface-done")).toHaveText("✓ Seen")
  await expect(miniRow).toHaveCount(0)
  await expect(localRow).toBeVisible()
  if (!(await seenOn(mini)) || (await seenOn(local))) throw new Error(`seen: mini ${await seenOn(mini)}, local ${await seenOn(local)}`)
  if (writes.local.length) throw new Error(`local writes: ${JSON.stringify(writes.local)}`)
  if (writes.mini.at(-1) !== 'POST /es/api/frontdesk/deliverables/seen {"id":"report","revision":1,"seen":true}' || !writes.mini.some((item) => item.startsWith("POST /es/api/attention/session")))
    throw new Error(`mini writes: ${JSON.stringify(writes.mini)}`)
  step("showing the Mini's frame marks only the Mini's store (operator session set up through the Mini) and leaves this host's row")

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(reader.locator(".surface-done")).toHaveText("✓ Seen", { timeout: 60_000 })
  await expect(localRow).toBeVisible({ timeout: 60_000 })
  await expect(miniRow).toHaveCount(0)
  step("the Mini's seen holds across a reload")

  await reader.getByRole("button", { name: "Mark unread" }).click()
  await expect(miniRow).toBeVisible()
  if (await seenOn(mini)) throw new Error("Mark unread not saved on the Mini")
  if (writes.local.length) throw new Error(`local writes: ${JSON.stringify(writes.local)}`)
  step("Mark unread brings the Mini's row back from the Mini's store only")

  const linkRow = band.locator("[data-nav-item='mini~surface:live']")
  await linkRow.click()
  await expect(page.locator("[data-surface-gap='own-host-only']")).toBeVisible()
  await page.waitForTimeout(1_000)
  if (await seenOn(mini, "live")) throw new Error("a link surface was marked before it was opened")
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.locator("[data-open-on-host='mini']").click()])
  await popup.waitForURL(`${miniOrigin}/?surface=live`)
  await popup.close()
  await expect(linkRow).toHaveCount(0)
  await expect(localRow).toBeVisible()
  if (!(await seenOn(mini, "live")) || writes.local.length) throw new Error(`live seen ${await seenOn(mini, "live")}, local writes ${JSON.stringify(writes.local)}`)
  step("a link surface is marked seen only once it was opened on its host, on the Mini only")
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`)
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error)} writes=${JSON.stringify(writes)}`)
} finally {
  console.log(results.join("\n"))
  await browser.close()
  await preview.close()
  await local.close()
  await mini.close()
}
