// #261 Work <-> Mini interactive session. Two fixture Cores, Local and a Mac Mini, both holding ses_a in the same
// directory. Opening the Mini's ses_a from Work shows the normal session view with every read, stream and write on
// the Mini (/hosts/mini/oc through the listener): steer and queue while busy, Stop, a plain send while idle, its
// permission and question answered there, an unconfirmed input read back there after reload, drafts independent
// of Local's ses_a, and an explicit unavailable line when the Mini stops answering. Local is never written.
// Run from packages/es-app: node test/work-host-session.browser.mjs
import { createRequire } from "node:module"
import { request as httpRequest } from "node:http"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const mini = await createFixture()
let miniDown = false
// The listener's host routes: /hosts/mini/oc/... reaches the Mini's Core, streams included.
const hostRoutes = {
  name: "test:hosts",
  configureServer: (server) => { server.middlewares.use((req, res, next) => {
    const match = /^\/hosts\/mini\/oc(\/.*)$/.exec(req.url ?? "")
    if (!match) return next()
    if (miniDown) {
      res.writeHead(502, { "content-type": "application/json" })
      return res.end('{"error":"Host unavailable"}')
    }
    const upstream = httpRequest(`${mini.url}${match[1]}`, { method: req.method, headers: { ...req.headers, host: new URL(mini.url).host } }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  }) },
}
const preview = await startPanelPreview([hostRoutes])
const local = preview.fixture
mini.messages = [{
  info: { id: "msg_m1", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: 1 } },
  parts: [{ id: "prt_m1", messageID: "msg_m1", sessionID: "ses_a", type: "text", text: "Hello from the Mini transcript" }],
}]
mini.permissions = []
mini.questions = []
local.permissions = []
// A global event on the Mini, as its /global/event stream carries them.
const emitMini = (type, properties) => {
  for (const [response, entry] of mini.eventStreams)
    if (entry.path === "/global/event") response.write(`data: ${JSON.stringify({ directory, payload: { type, properties } })}\n\n`)
}
const writes = (fixture) => fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))

const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.origin },
  { id: "mini", label: "Mac Mini", origin: "https://mini.example.ts.net", default: true },
] } }))
// The Vite listener has no host stream multiplexer; host streams use plain EventSource through the routes above.
await page.route("**/__es/events", (route) => route.fulfill({ json: { protocol: null } }))
const miniURL = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}&host=mini`
const box = () => page.locator(".prompt-box")
const editor = () => box().getByRole("textbox", { name: "Message", exact: true })
const button = (name) => box().getByRole("button", { name, exact: true })
const more = () => box().getByRole("button", { name: "More send options", exact: true })
const miniInputs = () => mini.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/input")
try {
  await page.goto(miniURL, { waitUntil: "domcontentloaded", timeout: 180_000 })
  // The normal session view, named with its host, showing the Mini's transcript (not Local's).
  await expect(page.locator(".session-page[data-host='mini']")).toBeVisible()
  await expect(page.locator(".session-page .session-host")).toContainText("Mac Mini")
  await expect(page.locator(".transcript")).toContainText("Hello from the Mini transcript")
  await expect(page.locator(".transcript")).not.toContainText("Review the composer")
  await expect(page.locator(".host-session-composer")).toHaveCount(0)
  // Another host's session offers no fork, archive, delete or rename from here.
  await expect(box().getByRole("button", { name: /Fork|Archive|Delete/ })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Rename session" })).toBeDisabled()

  // Busy (the fixture's default): Steer goes to the Mini as durable input.
  await editor().fill("Use the staging bucket")
  await expect(button("Steer")).toHaveAttribute("data-keyboard-target", "true")
  await button("Steer").click()
  await expect.poll(() => miniInputs().length).toBe(1)
  expect(miniInputs()[0].body).toEqual({ requestID: expect.any(String), text: "Use the staging bucket", delivery: "steer" })
  expect(miniInputs()[0].directory).toBe(directory)
  // Queue, from the secondary menu, also to the Mini.
  await editor().fill("After that, rerun the scorer")
  await more().click()
  await button("Queue").click()
  await expect.poll(() => miniInputs().length).toBe(2)
  expect(miniInputs()[1].body.delivery).toBe("queue")
  // The pending inputs are listed from the Mini.
  await expect(page.locator(".input-receipts li")).toHaveCount(2)
  expect(mini.calls.some((call) => call.method === "GET" && call.path === "/session/ses_a/input")).toBe(true)

  // Stop interrupts the Mini's turn; its idle status arrives on the Mini's stream.
  await box().getByRole("button", { name: /^Stop/ }).click()
  await expect.poll(() => mini.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/abort").length).toBe(1)
  emitMini("session.status", { sessionID: "ses_a", status: { type: "idle" } })
  await expect(page.locator(".session-state")).toHaveText("idle")

  // Idle: a plain send starts a turn on the Mini.
  await editor().fill("Start the nightly run")
  await editor().press("ControlOrMeta+Enter")
  await expect.poll(() => mini.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/prompt_async").length).toBe(1)
  expect(mini.calls.find((call) => call.path === "/session/ses_a/prompt_async").body.parts[0]).toEqual({ type: "text", text: "Start the nightly run" })

  // A permission and a question asked on the Mini are answered here, on the Mini.
  mini.permissions = [{ id: "per_mini", sessionID: "ses_a", permission: "bash", patterns: ["make deploy"], metadata: { command: "make deploy" } }]
  mini.questions = [{ id: "que_mini", sessionID: "ses_a", questions: [{ header: "Target", question: "Which bucket?", options: [{ label: "Staging", description: "" }, { label: "Prod", description: "" }] }] }]
  emitMini("permission.asked", mini.permissions[0])
  emitMini("question.asked", mini.questions[0])
  const permission = page.getByRole("region", { name: "Permission bash" })
  await expect(permission).toContainText("make deploy")
  await permission.getByRole("button", { name: "allow once", exact: true }).click()
  await expect.poll(() => mini.permissionReplies).toEqual([{ id: "per_mini", reply: "once" }])
  await page.getByRole("button", { name: /Staging/ }).click()
  await page.getByRole("button", { name: "Answer", exact: true }).click()
  await expect.poll(() => mini.questionReplies).toEqual([{ id: "que_mini", answers: [["Staging"]] }])

  // Drafts belong to their host: Local's ses_a (same ID, same directory) keeps its own.
  await editor().fill("Mini-only draft")
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded" })
  await expect(page.locator(".session-page:not([data-host])")).toBeVisible()
  await expect(page.locator(".transcript")).toContainText("Review the composer")
  await expect(editor()).not.toHaveValue("Mini-only draft")
  await page.goto(miniURL, { waitUntil: "domcontentloaded" })
  await expect(editor()).toHaveValue("Mini-only draft")

  // A lost acknowledgement: unknown, kept across reload, read back on the Mini, retried only by request.
  mini.status = "busy"
  emitMini("session.status", { sessionID: "ses_a", status: { type: "busy" } })
  await expect(page.locator(".session-state")).toHaveText("busy")
  mini.loseInput = true
  await button("Steer").click()
  await expect(page.locator(".input-admission")).toContainText("Not sent")
  const lost = miniInputs().at(-1).body
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator(".input-admission")).toBeVisible()
  await expect.poll(() => mini.calls.some((call) => call.method === "GET" && call.path === `/session/ses_a/input/${lost.requestID}`)).toBe(true)
  await page.getByRole("button", { name: "Check and retry same input", exact: true }).click()
  await expect(page.locator(".input-admission")).toHaveCount(0)
  expect(miniInputs().at(-1).body).toEqual(lost)

  // The Mini stops answering: one unavailable line, the last transcript stays, nothing goes to Local.
  miniDown = true
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator(".host-session-offline")).toContainText("Mac Mini is unreachable", { timeout: 20_000 })
  miniDown = false

  expect(writes(local).filter((call) => call.path !== "/api/attention/session")).toEqual([])
  expect(errors).toEqual([])
  console.log(`PASS work host session: Mini ses_a in the normal view (host-labelled), steer/queue/stop/send/permission/question on the Mini, pending list from the Mini, unknown input read back and retried there after reload, drafts independent of Local ses_a, unreachable line; Mini writes=${writes(mini).length}, Local writes=0`)
} finally {
  await browser.close()
  await preview.close()
  await mini.close()
}
