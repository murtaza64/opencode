import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const baseline = process.argv.includes("--baseline")
const native = !!process.env.ES_DESKTOP_EXECUTABLE
if (baseline && native) throw new Error("Baseline overrides the dev renderer, not the packaged native artifact")
const root = fileURLToPath(new URL("../../..", import.meta.url))
const prior = baseline ? Object.fromEntries(["session-activity.ts"].map((name) => [name,
  execFileSync("jj", ["file", "show", "-r", "67304e518f7b", `packages/es-app/src/${name}`], { cwd: root, encoding: "utf8" })])) : {}
const preview = await startPanelPreview(baseline ? [{ name: "baseline-fanout", enforce: "pre",
  transform(_code, id) { return prior[id.split("/").at(-1)] ?? undefined } }] : [])
const fixture = preview.fixture
fixture.permissionsByDirectory = new Map()
fixture.questionsByDirectory = new Map()
const child = { ...session("ses_child"), directory: "/history/child", parentID: "ses_a", slug: "child", version: "1" }
fixture.workspaceSessions.push(child, ...Array.from({ length: 64 }, (_, i) => ({
  ...session(`ses_history_${i}`), directory: `/history/${i}`, slug: `history-${i}`, version: "1",
  title: `History ${i}`, time: { created: 1, updated: 5 + i },
})))
const offscreen = fixture.workspaceSessions.find((item) => item.id === "ses_history_0")
const emit = (directory, type, properties) => {
  for (const [response, stream] of fixture.eventStreams)
    if (stream.path === "/global/event") response.write(`data: ${JSON.stringify({ directory, payload: { type, properties } })}\n\n`)
}
const profile = native ? await mkdtemp(path.join(tmpdir(), "es-fanout-native-")) : undefined
const app = native ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" } }) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const context = browser ? await browser.newContext({ viewport: { width: 1280, height: 800 } }) : undefined
const first = app ? await app.firstWindow() : await context.newPage()
if (app) {
  await first.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(first.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
  await app.evaluate(async ({ BrowserWindow, session }, origin) => {
    const window = new BrowserWindow({ show: false, webPreferences: { session: session.fromPartition("persist:editspace"),
      sandbox: true, contextIsolation: true, nodeIntegration: false } })
    await window.loadURL(origin)
  }, preview.origin)
}
const pages = app ? [first, (await app.windows()).find((page) => page !== first)] : [first, await context.newPage()]
const errors = []
pages.forEach((page) => page.on("pageerror", (error) => errors.push(error.message)))
const listReads = () => fixture.calls.filter((call) => call.path === "/experimental/session").length
const activityReads = () => fixture.calls.filter((call) => ["/session/status", "/permission", "/question"].includes(call.path))
try {
  await pages[0].goto(preview.url)
  await pages[1].goto(preview.url)
  await expect.poll(() => fixture.eventStreams.size).toBe(8)
  await expect(pages[0].locator(".topbar")).toContainText("Composer fixture")
  await expect(pages[1].locator(".topbar")).toContainText("Composer fixture")
  await expect.poll(() => activityReads().filter((call) => call.directory === directory).length).toBeGreaterThanOrEqual(3)
  await pages[0].waitForTimeout(2000)
  const cold = activityReads().length
  // Old code sampled all 66 historical directories: >=198 activity reads on cold start.
  if (!baseline) expect(new Set(activityReads().map((call) => call.directory)).size).toBeLessThan(30)
  const before = listReads()
  for (let i = 0; i < 20; i++) {
    offscreen.time.updated = 100 + i
    emit(offscreen.directory, "session.updated", { sessionID: offscreen.id, info: { ...offscreen, time: { ...offscreen.time } } })
  }
  await pages[0].locator(".es-switcher").selectOption("__all__")
  await pages[1].locator(".es-switcher").selectOption("__all__")
  await Promise.all(pages.map((page) => expect(page.locator(".sidebar .nav-item", { hasText: "History 0" })).toHaveCount(1)))
  await expect(pages[0].locator(".sidebar .nav-item", { hasText: "History 0" }).locator(".dot.unread")).toBeVisible()
  await pages[0].getByRole("button", { name: "Pin History 0", exact: true }).click()
  await expect(pages[0].locator(".pinned-section .nav-item", { hasText: "History 0" })).toBeVisible()
  if (!baseline) await expect.poll(() => listReads()).toBe(before)
  const gate = { id: "per_child", sessionID: child.id, permission: "bash", patterns: ["fixture gate"], always: [], metadata: {} }
  fixture.permissionsByDirectory.set(child.directory, [gate])
  emit(child.directory, "permission.asked", gate)
  await Promise.all(pages.map((page) => expect(page.locator(".notification-item", { hasText: "Composer fixture" })).toBeVisible()))
  await expect(pages[0].locator(".sidebar .session-entry .nav-item", { hasText: "Composer fixture" }).locator(".dot.pending")).toBeVisible()
  const question = { id: "que_offscreen", sessionID: offscreen.id,
    questions: [{ header: "Confirm", question: "Continue?", options: [{ label: "Yes", description: "Yes" }] }] }
  fixture.questionsByDirectory.set(offscreen.directory, [question])
  fixture.notifications = [{ id: `question:${question.id}`, kind: "question", session: offscreen.id,
    title: offscreen.title, directory: offscreen.directory, editspace: "fixture", updated: offscreen.time.updated }]
  emit(offscreen.directory, "question.asked", question)
  for (const [response, stream] of fixture.eventStreams)
    if (stream.path === "/api/notification-events") response.write("data: changed\n\n")
  await Promise.all(pages.map((page) => expect(page.locator(".notification-item", { hasText: "History 0" })).toBeVisible()))
  emit(child.directory, "permission.replied", { sessionID: child.id, requestID: gate.id, reply: "once" })
  fixture.permissionsByDirectory.set(child.directory, [])
  await Promise.all(pages.map((page) => expect(page.locator(".notification-item", { hasText: "Composer fixture" })).toHaveCount(0)))
  await Promise.all(pages.map((page) => page.locator(".es-switcher").selectOption("fixture")))
  await Promise.all(pages.map((page) => page.reload({ waitUntil: "domcontentloaded" })))
  await Promise.all(pages.map((page) => expect(page.locator(".notification-item", { hasText: "History 0" })).toBeVisible()))
  await pages[0].locator(".es-switcher").selectOption("__all__")
  await expect(pages[0].locator(".pinned-section .nav-item", { hasText: "History 0" })).toBeVisible()
  await pages[0].locator(".es-switcher").selectOption("fixture")
  await expect.poll(() => fixture.eventStreams.size).toBe(8)
  await pages[0].waitForTimeout(1500) // start the idle window after reconnect snapshots settle
  const idleStart = fixture.calls.length
  for (let i = 0; i < 10; i++) {
    offscreen.time.updated = 200 + i
    emit(offscreen.directory, "session.updated", { sessionID: offscreen.id, info: { ...offscreen, time: { ...offscreen.time } } })
    await pages[0].waitForTimeout(2000)
  }
  const idle = fixture.calls.slice(idleStart).filter((call) => ["/experimental/session", "/session/status", "/permission", "/question"].includes(call.path))
  if (!baseline) expect(idle.length).toBeLessThan(50)
  if (!baseline) {
    const missed = fixture.workspaceSessions.find((item) => item.id === "ses_history_1")
    fixture.questionsByDirectory.set(missed.directory, [{ id: "que_missed", sessionID: missed.id,
      questions: [{ header: "Confirm", question: "Proceed?", options: [{ label: "Yes", description: "Yes" }] }] }])
    // Neither the dashboard nor the live event feed reported this gate. The bounded background scan recovers it.
    await expect(pages[0].locator(".notification-item", { hasText: "History 1" })).toBeVisible({ timeout: 45_000 })
    const newSession = { ...session("ses_late"), slug: "late", version: "1", title: "New fixture session", time: { created: 1, updated: 500 } }
    fixture.workspaceSessions.push(newSession)
    emit(newSession.directory, "session.created", { sessionID: newSession.id, info: newSession })
    await pages[0].locator(".es-switcher").selectOption("__all__")
    await expect(pages[0].locator(".sidebar .nav-item", { hasText: newSession.title })).toBeVisible()
    emit(newSession.directory, "session.deleted", { sessionID: newSession.id, info: newSession })
    await expect(pages[0].locator(".sidebar .nav-item", { hasText: newSession.title })).toHaveCount(0)
  }
  expect(errors).toEqual([])
  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log(JSON.stringify({ cold_activity: cold, idle_20s_requests: idle.length, idle_session_lists: idle.filter((call) => call.path === "/experimental/session").length,
    tabs: 2, mode: native ? "packaged-native" : "browser", offscreenPermission: true, offscreenQuestion: true,
    backgroundRecovery: !baseline, writes: 0, baseline }))
  if (baseline) expect(idle.filter((call) => call.path === "/experimental/session")).toHaveLength(0)
} finally {
  await app?.close()
  await context?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}
