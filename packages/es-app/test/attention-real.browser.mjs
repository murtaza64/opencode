// Cross-repo contract test against the real dotfiles attention module and private SQLite.
// ES_ATTENTION_FIXTURE points to dotfiles/tests/attention_fixture.py; never a production server.
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import net from "node:net"
import { rm } from "node:fs/promises"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { apiProxy } from "../api-proxy.ts"

if (!process.env.ES_ATTENTION_FIXTURE) throw Error("Set ES_ATTENTION_FIXTURE to dotfiles/tests/attention_fixture.py")
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const probe = net.createServer()
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const origin = `http://127.0.0.1:${port}`
const child = spawn("uv", ["run", "--script", process.env.ES_ATTENTION_FIXTURE, "--origin", origin, "--partial"], { stdio: ["ignore", "pipe", "pipe"] })
const identity = await new Promise((resolve, reject) => {
  let output = ""
  const timeout = setTimeout(() => { child.kill(); reject(Error("fixture start timeout")) }, 120_000)
  child.stdout.on("data", chunk => {
    output += chunk.toString()
    const line = output.split("\n").find(value => value.startsWith('{"url":'))
    if (line) { clearTimeout(timeout); resolve(JSON.parse(line)) }
  })
  child.on("exit", code => { clearTimeout(timeout); reject(Error(`fixture exited ${code}`)) })
})
let preview
let browser
try {
  // The real apiProxy options exercise changeOrigin, preserved Origin/Cookie/Set-Cookie,
  // prefix rewriting and CSRF header forwarding rather than an in-browser mock.
  preview = await startPanelPreview([{ name: "private-real-attention-proxy", configResolved(config) {
    config.server.proxy = { "/es/api/attention": apiProxy(identity.url, "/es"), ...config.server.proxy }
  } }], port)
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => localStorage.setItem("es-app-all-projects", "true"))
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  const page = await context.newPage()
  await page.goto(origin)
  await expect(page.locator(".home-warning")).toContainText("attention-offline")
  const record = page.locator(".home-decision").filter({ has: page.getByRole("heading", { name: "Synthetic open: select ledger storage", exact: true }) }).first()
  await expect(record.getByRole("radio", { name: "Dashboard SQLite", exact: true })).toBeEnabled()
  await record.getByRole("radio", { name: "Dashboard SQLite", exact: true }).check()
  await record.getByRole("button", { name: "Send Dashboard SQLite", exact: true }).click()
  await expect(page.locator(".home-notice")).toContainText("Answer saved")
  await page.getByRole("button", { name: /^Answered/ }).click()
  const answered = page.locator(".home-decision").filter({ has: page.getByRole("heading", { name: "Synthetic open: select ledger storage", exact: true }) }).first()
  await expect(answered.locator(".home-delivery")).toContainText("Dashboard SQLite")
  await page.reload()
  await page.getByRole("button", { name: /^Answered/ }).click()
  await expect(answered.locator(".home-delivery")).toContainText("Dashboard SQLite")
  await expect(answered.locator(".home-answer-text")).toHaveCount(0)
  const cookies = await context.cookies()
  expect(cookies.some(cookie => cookie.name === "es_attention_operator" && cookie.httpOnly && cookie.path === "/" && cookie.sameSite === "Strict")).toBe(true)
  await answered.locator(".home-details > summary").click()
  await expect(answered.locator("pre")).toContainText('"actor": "operator"')
  await expect(answered.locator("pre")).toContainText('"action": "answer"')
  expect(preview.fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log("PASS real SQLite/HTTP/browser: trusted-Origin bootstrap, HttpOnly proxy cookie, CSRF selection-only answer, reload, immutable operator history, partial-project failure, no core runtime writes")
} finally {
  await browser?.close()
  await preview?.close()
  child.kill("SIGTERM")
  await new Promise(resolve => child.exitCode === null ? child.once("exit", resolve) : resolve())
  await rm(identity.root, { recursive: true, force: true })
}
