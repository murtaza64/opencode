// Stale green after a Core restart (orchestrator #1320, RHC #818): a busy dot must not outlive the Core that reported
// it. Covers a stream outage, a restarted Core with an empty status map, a busy event received under another
// directory spelling for a session whose indexed directory is out of view, and events racing the reconnect snapshot.
// Private fixture only: no live Core, auth, POST, restart or install.
import { selectScope } from "./scope.mjs"
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const scratch = await mkdtemp(path.join(tmpdir(), "status-restart-"))
const site = await startPanelPreview([{
  name: "status-restart:isolated-deps",
  config: () => ({ cacheDir: path.join(scratch, "vite"), optimizeDeps: { include: ["@opencode-ai/ui > @shikijs/stream", "@opencode-ai/ui > remend"] } }),
}])
const fixture = site.fixture
// ses_c lives in a second directory; Core may also report it under another spelling of that directory (a symlink).
const second = "/fixture second/project"
const alias = "/fixture second link/project"
fixture.workspaceSessions.push({ ...session("ses_c"), title: "Second directory session", directory: second, time: { created: 1, updated: Date.now() } })
// Core's per-directory status map, read when the snapshot request arrives; `held` delays the answer.
const core = new Map([[directory, { ses_a: { type: "busy" } }], [second, {}], [alias, {}]])
const held = new Map()
const reads = []
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.route("**/oc/session/status?*", async (route) => {
  const dir = new URL(route.request().url()).searchParams.get("directory")
  const body = structuredClone(core.get(dir) ?? {})
  reads.push(dir)
  await held.get(dir)?.promise
  await route.fulfill({ json: body })
})
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const publish = (dir, sessionID, type) => {
  for (const [response, stream] of fixture.eventStreams)
    if (stream.path === "/global/event")
      response.write(`data: ${JSON.stringify({ directory: dir, payload: { type: "session.status", properties: { sessionID, status: { type } } } })}\n\n`)
}
const globalStreams = () => [...fixture.eventStreams.values()].filter((stream) => stream.path === "/global/event").length
// The unified sidebar shows status on the row's avatar corner (data-dot on .session-entry).
const dot = (id) => page.locator(`.sidebar .session-entry:has(a[href*="/session/${id}?"])`).first()
const hold = (dir) => {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  held.set(dir, { promise })
  return () => { held.delete(dir); release() }
}
// Core restarts: the global stream drops and stays refused until `restart.up()`; the new Core runs nothing.
const restart = async () => {
  fixture.refuseGlobalEvents = true
  for (const [response, stream] of fixture.eventStreams) if (stream.path === "/global/event") response.end()
  await expect.poll(globalStreams).toBe(0)
  return {
    up: async (next = {}) => {
      for (const dir of core.keys()) core.set(dir, next[dir] ?? {})
      fixture.refuseGlobalEvents = false
      await expect.poll(globalStreams, { timeout: 40000 }).toBeGreaterThan(0)
    },
  }
}
const results = []
const check = async (name, run) => {
  try {
    await run()
    results.push(`PASS ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${String(error.message).split("\n").slice(0, 3).join(" | ")}`)
  }
}
try {
  await page.goto(`${origin()}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await selectScope(page, "__all__")
  await expect(dot("ses_a")).toHaveAttribute("data-dot", "busy")
  await expect.poll(globalStreams).toBeGreaterThan(0)

  await check("outage: a busy dot from the dropped stream is not shown as busy while the stream is down", async () => {
    const down = await restart()
    try {
      await expect(dot("ses_a")).not.toHaveAttribute("data-dot", "busy", { timeout: 3000 })
    } finally {
      await down.up()
    }
  })

  await check("restart: the reconnect snapshot from a Core with an empty status map clears the busy dot", async () => {
    await expect(dot("ses_a")).not.toHaveAttribute("data-dot", "busy", { timeout: 5000 })
  })

  await check("cross-directory: a busy event under an alias spelling is cleared by reconnect even while its indexed directory is out of view", async () => {
    await expect(dot("ses_c")).toBeVisible()
    await expect(dot("ses_c")).not.toHaveAttribute("data-dot", "busy")
    publish(alias, "ses_c", "busy")
    await expect(dot("ses_c")).toHaveAttribute("data-dot", "busy")
    // Scroll every row out of view: only ses_a (the open session) keeps its directory relevant.
    await page.locator(".sidebar").evaluate((el) => { el.style.transform = "translateY(-200vh)" })
    await page.waitForTimeout(300)
    const after = reads.length
    const down = await restart()
    await down.up()
    // The reconnect must re-read ses_c's indexed or alias directory; the open session's directory alone is not enough.
    await expect.poll(() => reads.slice(after).some((dir) => dir === second || dir === alias), { timeout: 5000 }).toBe(true)
    await page.waitForTimeout(1000)
    await page.locator(".sidebar").evaluate((el) => { el.style.transform = "" })
    await expect(dot("ses_c")).not.toHaveAttribute("data-dot", "busy", { timeout: 3000 })
  })

  await check("race: a busy event during the reconnect snapshot wins over the snapshot's empty map", async () => {
    const down = await restart()
    const release = hold(directory)
    const before = reads.length
    await down.up()
    await expect.poll(() => reads.slice(before).includes(directory), { timeout: 5000 }).toBe(true)
    publish(directory, "ses_a", "busy")
    await expect(dot("ses_a")).toHaveAttribute("data-dot", "busy")
    release()
    await page.waitForTimeout(1000)
    await expect(dot("ses_a")).toHaveAttribute("data-dot", "busy")
  })

  await check("race: an idle event during the reconnect snapshot wins over the snapshot's stale busy", async () => {
    const down = await restart()
    const release = hold(directory)
    const before = reads.length
    // This snapshot is taken before the session goes idle, so it still says busy.
    await down.up({ [directory]: { ses_a: { type: "busy" } } })
    await expect.poll(() => reads.slice(before).includes(directory), { timeout: 5000 }).toBe(true)
    publish(directory, "ses_a", "idle")
    await expect(dot("ses_a")).not.toHaveAttribute("data-dot", "busy")
    release()
    core.set(directory, {})
    await page.waitForTimeout(1000)
    await expect(dot("ses_a")).not.toHaveAttribute("data-dot", "busy")
  })

  await check("blocked: a busy session whose exact directory holds a permission after restart shows pending, not active", async () => {
    // Only ses_c's exact (indexed) directory lists the request; the open session's directory lists none.
    fixture.permissionsByDirectory = new Map([[second, [
      { id: "per_restart", sessionID: "ses_c", permission: "bash", patterns: ["fixture command"], metadata: {} },
    ]]])
    const down = await restart()
    await down.up({ [second]: { ses_c: { type: "busy" } } })
    await expect(dot("ses_c")).toHaveAttribute("data-dot", "pending", { timeout: 35000 })
  })

  expect(errors).toEqual([])
  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
} finally {
  await browser.close()
  await site.close()
  await rm(scratch, { recursive: true, force: true })
}
for (const line of results) console.log(line)
if (results.some((line) => line.startsWith("FAIL"))) process.exit(1)

function origin() {
  return site.origin
}
