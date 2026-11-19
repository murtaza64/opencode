// Matched "test" prompt, no tools, same model and agent as `ori opencode` (openrouter/openrouter/auto, yolo), warm directory.
// Arms: A `ori opencode run` (its own standalone server); B `opencode run --attach` live Core; C installed Desktop on
// live Core; D `opencode run --attach` to a private `opencode serve` (isolated server, live config). Times are from process spawn (CLI) or
// Enter (Desktop) to the first reply text; for live-Core arms also to Core's user message on its event stream.
// Run from packages/es-app: node test/matched-test.mjs [--n 5] [--arms A,B,C,D] [--dir <warm dir>]
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { createServer } from "node:http"

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index === -1 ? fallback : process.argv[index + 1] }
const N = Number(arg("n", 5)), ARMS = arg("arms", "A,B,C,D").split(","), BASE = arg("base", "http://127.0.0.1:4096")
const MODEL = "openrouter/openrouter/auto", AGENT = "yolo", PROMPT = "test"
const OPENCODE = path.join(homedir(), ".local/bin/opencode"), ORI = path.join(homedir(), ".local/bin/ori")
const DESKTOP = path.join(homedir(), "Applications/Editspace.app/Contents/MacOS/Editspace")
const dir = arg("dir", path.join(tmpdir(), "matched-test"))
await mkdir(dir, { recursive: true })
const q = `directory=${encodeURIComponent(dir)}`

// Live Core's first user message and first text delta for any new session in the directory.
const watch = () => {
  const marks = {}
  const controller = new AbortController()
  void (async () => {
    const response = await fetch(`${BASE}/event?${q}`, { signal: controller.signal })
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      for (let at = buffer.indexOf("\n\n"); at !== -1; at = buffer.indexOf("\n\n")) {
        const line = buffer.slice(0, at).split("\n").find((item) => item.startsWith("data: "))
        buffer = buffer.slice(at + 2)
        if (!line) continue
        const event = JSON.parse(line.slice(6))
        const props = event.properties ?? {}
        if (event.type === "message.updated" && props.info?.role === "user") marks.user ??= Date.now()
        if (event.type === "message.part.delta" && props.field === "text") marks.text ??= Date.now()
      }
    }
  })().catch(() => {})
  return { marks, ready: new Promise((resolve) => setTimeout(resolve, 300)), close: () => controller.abort() }
}

// One CLI turn: spawn -> first text event in its JSON output.
const cli = (command, args) => new Promise((resolve) => {
  const start = Date.now()
  let first
  // stdin closed: `run` treats piped stdin as part of the prompt and waits for EOF.
  const child = spawn(command, args, { cwd: dir, env: process.env, stdio: ["ignore", "pipe", "pipe"] })
  let buffer = ""
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!first && line.includes('"type":"text"')) first = Date.now()
    }
  })
  child.on("close", (code) => resolve({ start, first, code, end: Date.now() }))
})

const rows = []
const record = (arm, row) => { rows.push({ arm, ...row }); console.log(JSON.stringify({ arm, ...row })) }
const runArgs = ["run", "--format", "json", "-m", MODEL, "--agent", AGENT, "--dir", dir]

// Warm the live Core instance once (boot + first-turn MCP startup).
if (ARMS.some((arm) => arm === "B" || arm === "C")) {
  const warm = await cli(OPENCODE, [...runArgs, "--attach", BASE, PROMPT])
  console.log(`WARM live ${warm.end - warm.start} ms`)
}

// D: a private Core with the live config on its own port, warmed once like live Core.
let PRIVATE, privateServer
if (ARMS.includes("D")) {
  const port = 47000 + Math.floor(Math.random() * 900)
  PRIVATE = `http://127.0.0.1:${port}`
  privateServer = spawn(OPENCODE, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { stdio: "ignore", env: process.env })
  for (let at = Date.now(); Date.now() - at < 30000; await new Promise((resolve) => setTimeout(resolve, 250)))
    if (await fetch(`${PRIVATE}/global/health`).then((response) => response.ok, () => false)) break
  const warm = await cli(OPENCODE, [...runArgs, "--attach", PRIVATE, PROMPT])
  console.log(`WARM private ${warm.end - warm.start} ms`)
}

let app, page, origin, dashboard
if (ARMS.includes("C")) {
  const { _electron } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
  dashboard = createServer((request, response) => {
    if (request.url?.split("?")[0] !== "/api/editspaces") return void response.writeHead(404).end()
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ editspaces: [], default: null }))
  })
  await new Promise((resolve) => dashboard.listen(0, "127.0.0.1", resolve))
  const profile = await mkdtemp(path.join(tmpdir(), "matched-desktop-"))
  app = await _electron.launch({ timeout: 20000, executablePath: DESKTOP, args: ["--use-mock-keychain"], env: {
    PATH: process.env.PATH, HOME: profile, ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden",
    OPENCODE_URL: BASE, ES_DASHBOARD_URL: `http://127.0.0.1:${dashboard.address().port}`,
  } })
  page = await app.firstWindow()
  await page.waitForURL("http://127.0.0.1:*/", { timeout: 20000 })
  origin = new URL(page.url()).origin
}

try {
  for (let index = 0; index < N; index++) for (const arm of ARMS) {
    if (arm === "A" || arm === "D") {
      // A: Ori's launcher adds --standalone and its OpenRouter credential; D: the same binary standalone, no Ori.
      const result = arm === "A" ? await cli(ORI, ["opencode", ...runArgs, PROMPT]) : await cli(OPENCODE, [...runArgs, "--attach", PRIVATE, PROMPT])
      record(arm, { start_to_text_ms: result.first ? result.first - result.start : null, start_to_exit_ms: result.end - result.start, code: result.code })
    }
    if (arm === "B") {
      const core = watch()
      await core.ready
      const result = await cli(OPENCODE, [...runArgs, "--attach", BASE, PROMPT])
      core.close()
      record(arm, { start_to_core_user_ms: core.marks.user - result.start, start_to_core_text_ms: core.marks.text - result.start, start_to_text_ms: result.first ? result.first - result.start : null, start_to_exit_ms: result.end - result.start, code: result.code })
    }
    if (arm === "C") {
      const session = await fetch(`${BASE}/session?${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "matched-test" }) }).then((response) => response.json())
      const core = watch()
      await core.ready
      await page.goto(`${origin}/session/${session.id}?${q}`, { waitUntil: "domcontentloaded" })
      const editor = page.getByRole("textbox", { name: "Message", exact: true })
      await editor.fill(PROMPT, { timeout: 20000 })
      await page.waitForFunction(() => !document.querySelector("button[aria-label='Send']")?.disabled, undefined, { timeout: 20000 })
      await page.waitForTimeout(300)
      await page.evaluate(() => {
        const marks = window.__live = {}
        window.addEventListener("keydown", (event) => { if (event.key === "Enter") marks.start ??= Date.now() }, { capture: true })
        const tick = () => {
          const rows = [...document.querySelectorAll(".transcript [data-find-message]")].filter((row) => !row.querySelector("[data-component='user-message']"))
          if (marks.start && rows.some((row) => row.textContent.trim().length > 0)) marks.text = Date.now()
          if (!marks.text) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await editor.press("Control+Enter")
      await page.waitForFunction(() => window.__live.text, undefined, { timeout: 120000 }).catch(() => {})
      const seen = await page.evaluate(() => window.__live)
      core.close()
      record(arm, { start_to_core_user_ms: core.marks.user - seen.start, start_to_core_text_ms: core.marks.text - seen.start, start_to_text_ms: seen.text ? seen.text - seen.start : null })
    }
  }
} finally {
  await app?.close().catch(() => {})
  dashboard?.close()
  privateServer?.kill()
}
const pct = (list, p) => { const sorted = list.filter((value) => Number.isFinite(value)).sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : null }
for (const arm of ARMS) {
  const mine = rows.filter((row) => row.arm === arm)
  console.log(`SUMMARY ${arm} n=${mine.length} ` + JSON.stringify(Object.fromEntries(Object.keys(mine[0] ?? {}).filter((key) => key.endsWith("_ms")).map((key) => [key, { p50: pct(mine.map((row) => row[key]), 0.5), p95: pct(mine.map((row) => row[key]), 0.95) }]))))
}
