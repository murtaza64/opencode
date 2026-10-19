import { _electron, expect } from "@playwright/test"
import { spawn, execFileSync } from "node:child_process"
import { createServer, request } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

if (!process.env.ES_ATTENTION_FIXTURE || !process.env.ES_DESKTOP_EXECUTABLE)
  throw Error("Set ES_ATTENTION_FIXTURE to the disposable dotfiles attention_fixture.py and ES_DESKTOP_EXECUTABLE to the lane-built packaged executable")
const core = await createFixture()
const profile = await mkdtemp(path.join(tmpdir(), "es-native-attention-"))
let backend
let identity
let app
let attentionTarget
const bridge = createServer((req, res) => {
  if (req.url.startsWith("/api/wingman")) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(req.url.startsWith("/api/wingman/transcript")
      ? { status: "processing", turns: [{ output: "Native synthetic Wingman transcript" }], turns_dropped: 0 }
      : { lanes: [{ lane: "cloud-fixture", owner: "wingman:synthetic", "wingman-status": "processing", "wingman-cost": "0.12" }], error: "" }))
    return
  }
  const target = req.url.startsWith("/api/attention") ? attentionTarget : core.url
  if (!target) { res.writeHead(503); res.end(); return }
  const upstream = request(`${target}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(target).host } }, response => {
    res.writeHead(response.statusCode, response.headers)
    response.pipe(res)
  })
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
  req.pipe(upstream)
})
await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve))
const dashboard = `http://127.0.0.1:${bridge.address().port}`
try {
  backend = spawn("uv", ["run", "--script", process.env.ES_ATTENTION_FIXTURE, "--origin", dashboard, "--partial"], { stdio: ["ignore", "pipe", "pipe"] })
  identity = await new Promise((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => reject(Error("backend startup timed out")), 120_000)
    backend.stdout.on("data", chunk => {
      output += chunk.toString()
      const line = output.split("\n").find(value => value.startsWith('{"url":'))
      if (line) { clearTimeout(timer); resolve(JSON.parse(line)) }
    })
    backend.on("exit", code => { clearTimeout(timer); reject(Error(`backend exited ${code}`)) })
  })
  attentionTarget = identity.url
  const known = await fetch(`${identity.url}/fixture`).then(res => res.json())
  expect(known.fixture).toBe(true)
  expect(known.root).toBe(identity.root)
  expect(execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP:${new URL(identity.url).port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim()).toBe(String(identity.pid))
  app = await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE, env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: core.url, ES_DASHBOARD_URL: dashboard, OPENCODE_SERVER_PASSWORD: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "" } })
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
  const page = await app.firstWindow()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.waitForURL("http://127.0.0.1:*/")
  const origin = new URL(page.url()).origin
  expect(["4096", "7777"]).not.toContain(new URL(origin).port)
  expect(execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP:${new URL(origin).port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim()).toBe(String(app.process().pid))
  await page.evaluate(() => localStorage.setItem("es-app-all-projects", "true"))
  await page.reload()
  // Native origin is genuinely dynamic and not trusted directly by the ledger.
  expect((await fetch(`${identity.url}/api/attention/session`, { method: "POST", headers: { origin, "x-attention-csrf": "1", "content-type": "application/json" }, body: "{}" })).status).toBe(403)
  const open = page.locator(".home-decision").filter({ has: page.getByRole("heading", { name: "Synthetic open: select ledger storage", exact: true }) }).first()
  await expect(open.getByRole("radio", { name: "Dashboard SQLite" })).toBeEnabled()
  await open.getByRole("radio", { name: "Dashboard SQLite" }).check()
  await open.getByRole("button", { name: "Review choice" }).click()
  await page.getByRole("button", { name: "Record choice only" }).click()
  await expect(page.locator(".home-notice")).toContainText("Decision saved · not sent")
  await expect(page.locator(".home-warning")).toContainText("attention-offline")
  await page.getByRole("button", { name: "Recorded / not sent 2", exact: true }).click()
  await expect(page.locator(".home-recorded").first()).toContainText("Dashboard SQLite · not sent")
  await page.reload()
  await page.getByRole("button", { name: "Recorded / not sent 2", exact: true }).click()
  await expect(page.locator(".home-recorded").first()).toContainText("Dashboard SQLite · not sent")
  expect(await app.evaluate(async ({ session }) => (await session.fromPartition("persist:editspace").cookies.get({ name: "es_attention_operator" })).some(cookie => cookie.httpOnly && cookie.path === "/" && cookie.sameSite === "strict"))).toBe(true)
  await page.getByRole("button", { name: "Snoozed 1", exact: true }).click()
  await page.getByRole("button", { name: "Return to Needs you" }).click()
  await page.getByRole("button", { name: "Open 2", exact: true }).click()
  await page.locator(".home-decision").first().getByRole("button", { name: "Snooze 1h" }).click()
  await page.getByRole("button", { name: "Snoozed 1", exact: true }).click()
  await expect(page.locator(".home-decision")).toContainText("Snoozed until")
  const conflict = await page.evaluate(async () => {
    const list = await fetch("/es/api/attention?view=all").then(res => res.json())
    const row = list.records.find(row => row.status === "snoozed")
    return fetch(`/es/api/attention/${row.id}/commands?es=${encodeURIComponent(row.editspace)}`, { method: "POST", headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: JSON.stringify({ command_id: crypto.randomUUID(), expected_revision: 1, action: "wake" }) }).then(res => res.status)
  })
  expect(conflict).toBe(409)
  const cloud = page.getByRole("region", { name: "Cloud agents", exact: true })
  await cloud.getByText("Other cloud tasks (1)", { exact: true }).click()
  await cloud.getByRole("button", { name: "Pin", exact: true }).click()
  await cloud.getByRole("button", { name: "Load transcript", exact: true }).click()
  await expect(cloud).toContainText("Native synthetic Wingman transcript")
  for (const route of ["/es/api/attention/publish", "/oc/pty", "/oc/session/ses_a/shell", "/es/api/run", "/es/api/wingman", "/es/api/wingman/transcript"])
    expect(await page.evaluate(route => fetch(route, { method: "POST" }).then(res => res.status), route)).toBe(403)
  expect(core.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  expect(errors).toEqual([])
  console.log(`PASS packaged Electron real SQLite: PID/listener/private DB verified; dynamic native origin binding; operator cookie bootstrap/reload; choice/snooze/CAS; forbidden routes intact; zero core writes. Native PID ${app.process().pid}, backend PID ${identity.pid}`)
} finally {
  await app?.close()
  backend?.kill("SIGTERM")
  if (backend) await new Promise(resolve => backend.exitCode === null ? backend.once("exit", resolve) : resolve())
  bridge.closeAllConnections()
  await new Promise(resolve => bridge.close(resolve))
  await core.close()
  await rm(profile, { recursive: true, force: true })
  if (identity) await rm(identity.root, { recursive: true, force: true })
}
