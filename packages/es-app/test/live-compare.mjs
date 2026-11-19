// Head-to-head on the live Core: installed Desktop (isolated profile) vs attached TUI, same prompt, fresh
// session each run. The harness's own SSE subscription stamps when Core emitted each event; each client
// stamps (wall clock) when it first shows it. Reports submit -> first visible text/tool and SSE -> visible.
// Run from packages/es-app: node test/live-compare.mjs [--runs 3] [--base http://127.0.0.1:4096]
// Env: HARNESS_DESKTOP_BINARY (default installed Editspace), HARNESS_TUI_BINARY (default ~/.local/bin/opencode).
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { createServer } from "node:http"

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index === -1 ? fallback : process.argv[index + 1] }
const RUNS = Number(arg("runs", 3)), BASE = arg("base", "http://127.0.0.1:4096")
const DESKTOP = process.env.HARNESS_DESKTOP_BINARY ?? path.join(homedir(), "Applications/Editspace.app/Contents/MacOS/Editspace")
const TUI = process.env.HARNESS_TUI_BINARY ?? path.join(homedir(), ".local/bin/opencode")
const { _electron } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
// The command and its output are not substrings of the prompt, so a client showing them is showing the tool row.
const PROMPT = "Use the bash tool once to run: echo $((6*7))TOK ; then reply with exactly the word FINISHED."
const work = await mkdtemp(path.join(tmpdir(), "live-compare-"))
// --dir reuses a warm directory: a fresh Core instance's first turn waits on MCP startup (about 65 s with the VPN down).
const dir = arg("dir", path.join(work, "project"))
await mkdir(dir, { recursive: true })
const q = `directory=${encodeURIComponent(dir)}`

// Core timeline for one session, from Core's own event stream.
const watch = (sessionID) => {
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
        const part = props.part
        if ((props.sessionID ?? part?.sessionID ?? props.info?.sessionID) !== sessionID) continue
        const now = Date.now()
        if (event.type === "message.updated" && props.info?.role === "user") marks.user ??= now
        if (event.type === "message.updated" && props.info?.role === "assistant") marks.assistant ??= now
        if (part?.type === "tool") marks.toolPart ??= now
        if (part?.type === "tool" && part.state?.status !== "pending") marks.tool ??= now
        if (part?.type === "tool" && part.state?.status === "completed") marks.output ??= now
        if (event.type === "message.part.delta" && props.field === "text") marks.text ??= now
        if (event.type === "message.part.delta" && props.field === "text" && marks.output) marks.finalText ??= now
      }
    }
  })().catch(() => {})
  return { marks, close: () => controller.abort() }
}

const create = async () => {
  const response = await fetch(`${BASE}/session?${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "live-compare" }) })
  assert(response.ok, `create ${response.status}`)
  return (await response.json()).id
}

const dashboard = createServer((request, response) => {
  if (request.url?.split("?")[0] !== "/api/editspaces") return void response.writeHead(404).end()
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ editspaces: [], default: null }))
})
await new Promise((resolve) => dashboard.listen(0, "127.0.0.1", resolve))
const profile = path.join(work, "desktop")
await mkdir(profile)
const app = await _electron.launch({ timeout: 20000, executablePath: DESKTOP, args: ["--use-mock-keychain"], env: {
  PATH: process.env.PATH, HOME: profile, ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden",
  OPENCODE_URL: BASE, ES_DASHBOARD_URL: `http://127.0.0.1:${dashboard.address().port}`,
} })
const expectScript = path.join(work, "tui.exp")
await writeFile(expectScript, `set timeout 120
log_user 0
lassign $argv binary base dir session prompt
spawn -noecho $binary attach $base --dir $dir --session $session --pure
stty rows 50 columns 140
expect {
  -re {ctrl\\+p|commands|ask anything} {}
  timeout {puts stderr "TUI readiness timed out"; exit 2}
}
after 500
send -- $prompt
set start [clock milliseconds]
send -- "\\r"
set first 0; set tool 0; set output 0; set final 0
expect {
  -re {42TOK} {set output [clock milliseconds]; exp_continue}
  -re {\\$ echo} {if {!$tool} {set tool [clock milliseconds]}; exp_continue}
  -re {FINISHED} {if {$output} {set final [clock milliseconds]} else {exp_continue}}
  timeout {puts stderr "TUI timed out"; exit 3}
}
close
puts "TUI start=$start tool=$tool output=$output final=$final"
`)

const rows = []
const sessions = { desktop: [], tui: [] }
const switches = []
try {
  const page = await app.firstWindow()
  await page.waitForURL("http://127.0.0.1:*/", { timeout: 20000 })
  const origin = new URL(page.url()).origin
  // Warm the directory's Core instance (boot and first-turn MCP startup) so neither client pays it.
  await fetch(`${BASE}/session/status?${q}`)
  if (process.argv.includes("--warm")) {
    const warm = await create()
    const core = watch(warm)
    await fetch(`${BASE}/session/${warm}/prompt_async?${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text: PROMPT }] }) })
    const started = Date.now()
    while (!core.marks.finalText && Date.now() - started < 180000) await new Promise((resolve) => setTimeout(resolve, 500))
    core.close()
    console.log(`WARM ${Date.now() - started} ms`)
  }
  for (let run = 0; run < RUNS; run++) for (const client of run % 2 ? ["tui", "desktop"] : ["desktop", "tui"]) {
    const session = await create()
    sessions[client].push(session)
    const core = watch(session)
    await new Promise((resolve) => setTimeout(resolve, 300))
    let seen
    if (client === "desktop") {
      await page.goto(`${origin}/session/${session}?${q}`, { waitUntil: "domcontentloaded" })
      const editor = page.getByRole("textbox", { name: "Message", exact: true })
      await editor.fill(PROMPT, { timeout: 20000 })
      await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 20000 })
      await page.waitForFunction(() => !document.querySelector("button[aria-label='Send']")?.disabled, undefined, { timeout: 20000 })
      await page.waitForTimeout(300)
      await page.evaluate(() => {
        const marks = window.__live = {}
        const tick = () => {
          // Assistant rows only: the prompt itself contains the final word.
          const rows = [...document.querySelectorAll(".transcript [data-find-message]")].filter((row) => !row.querySelector("[data-component='user-message']"))
          const text = rows.map((row) => row.textContent).join(" ")
          const wall = Date.now()
          if (marks.start) {
            if (!marks.tool && rows.some((row) => row.querySelector(".tool-run-summary, .tool-chip, [data-component='tool-part'], .tool-strip-row"))) marks.tool = wall
            // Tool output is collapsed by design; a visible row counts once its output exists in the DOM or the reply follows it.
            if (!marks.output && text.includes("42TOK")) marks.output = wall
            if (!marks.final && marks.tool && /FINISHED/.test(text)) marks.final = wall
          }
          if (!marks.final) requestAnimationFrame(tick)
        }
        window.addEventListener("keydown", (event) => { if (event.key === "Enter") marks.start ??= Date.now() }, { capture: true })
        requestAnimationFrame(tick)
      })
      await editor.press("Control+Enter")
      await page.waitForFunction(() => window.__live.final, undefined, { timeout: 120000 }).catch(async (error) => {
        console.error("DESKTOP STATE", JSON.stringify(await page.evaluate(() => ({ marks: window.__live, url: location.href, transcript: document.querySelector(".transcript")?.outerHTML.slice(0, 2500), body: document.body.innerText.slice(0, 800), rows: [...document.querySelectorAll(".transcript [data-find-message]")].map((row) => ({ user: !!row.querySelector("[data-component='user-message']"), cls: row.className, html: row.innerHTML.slice(0, 600) })) }))))
        throw error
      })
      seen = await page.evaluate(() => window.__live)
    } else {
      const { stdout } = await promisify(execFile)("/usr/bin/expect", [expectScript, TUI, BASE, dir, session, PROMPT], { timeout: 150000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: "xterm-256color" } })
      const match = stdout.match(/TUI start=(\d+) tool=(\d+) output=(\d+) final=(\d+)/)
      assert(match, stdout)
      seen = { start: +match[1], tool: +match[2] || undefined, output: +match[3], final: +match[4] }
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    core.close()
    const messages = await fetch(`${BASE}/session/${session}/message?${q}`).then((response) => response.json())
    const model = messages.find((message) => message.info.role === "assistant")?.info
    const c = core.marks
    const row = { client, model: model ? `${model.providerID}/${model.modelID}` : "?",
      submit_to_core_user_ms: c.user - seen.start, core_user_to_assistant_ms: c.assistant - c.user, core_user_to_tool_part_ms: c.toolPart - c.user,
      submit_to_core_text_ms: c.text - seen.start, submit_to_tool_visible_ms: seen.tool ? seen.tool - seen.start : null,
      tool_sse_to_visible_ms: seen.tool && c.tool ? seen.tool - c.tool : null, output_sse_to_visible_ms: seen.output ? seen.output - c.output : null,
      final_text_sse_to_visible_ms: c.finalText ? seen.final - c.finalText : null, submit_to_finished_ms: seen.final - seen.start }
    rows.push(row)
    console.log(JSON.stringify(row))
  }
  // Session switch: in-app sidebar click to a finished session; TUI: a fresh attach to it (it has no in-place switch).
  const page2 = await app.firstWindow()
  const done = [...sessions.desktop, ...sessions.tui]
  for (let index = 0; index < Math.min(6, done.length * 2); index++) {
    const id = done[index % done.length]
    const ms = await page2.evaluate(async (id) => {
      const start = performance.now()
      // In-app navigation (the isolated profile's sidebar does not list these sessions).
      history.pushState(null, "", `/session/${id}${location.search}`)
      window.dispatchEvent(new PopStateEvent("popstate"))
      return new Promise((resolve) => { const tick = () => {
        const rows = [...document.querySelectorAll(".transcript [data-find-message]")].filter((row) => !row.querySelector("[data-component='user-message']"))
        if (location.pathname.includes(id) && rows.some((row) => row.textContent.includes("FINISHED"))) return resolve(Math.round(performance.now() - start))
        if (performance.now() - start > 15000) return resolve(null)
        requestAnimationFrame(tick) }; tick() })
    }, id)
    switches.push({ client: "desktop", ms })
  }
  await writeFile(path.join(work, "attach.exp"), `set timeout 30
log_user 0
lassign $argv binary base dir session
set start [clock milliseconds]
spawn -noecho $binary attach $base --dir $dir --session $session --pure
stty rows 50 columns 140
expect { -re {FINISHED} {puts "ATTACH [expr {[clock milliseconds] - $start}]"} timeout {puts "ATTACH -1"} }
close
`)
  for (const id of done.slice(0, 4)) {
    const { stdout } = await promisify(execFile)("/usr/bin/expect", [path.join(work, "attach.exp"), TUI, BASE, dir, id], { timeout: 40000, env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: "xterm-256color" } })
    switches.push({ client: "tui-attach", ms: Number(stdout.match(/ATTACH (-?\d+)/)?.[1]) })
  }
  console.log("SWITCH " + JSON.stringify(switches))
} finally {
  await app.close().catch(() => {})
  dashboard.close()
}
const pct = (list, p) => { const sorted = list.filter((value) => value != null).sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null }
for (const client of ["desktop", "tui"]) {
  const mine = rows.filter((row) => row.client === client)
  console.log(`SUMMARY ${client} ` + JSON.stringify(Object.fromEntries(Object.keys(mine[0]).filter((key) => key.endsWith("_ms")).map((key) => [key, { p50: pct(mine.map((row) => row[key]), 0.5), p95: pct(mine.map((row) => row[key]), 0.95) }]))))
}
