// Stage-1 real round trip on the Mac Mini through the native Mac Mini tab: spawn one agent from the
// New session page, view its transcript, send one steer. Real provider work on the Mini: run only
// with the Mini owner's approved prompt and steer (ES_TEST_PROMPT / ES_TEST_STEER). Local runs
// against the private composer fixture so live laptop sessions are never touched.
import { _electron, expect } from "@playwright/test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

const prompt = process.env.ES_TEST_PROMPT
const steer = process.env.ES_TEST_STEER
const directory = process.env.ES_TEST_DIRECTORY ?? "/Users/murtaza/dotfiles"
const model = process.env.ES_TEST_MODEL ?? "duolingo-anthropic\u0000claude-opus-5-5"
if (!prompt || !steer) throw new Error("Set ES_TEST_PROMPT and ES_TEST_STEER to the approved texts")
const root = fileURLToPath(new URL("..", import.meta.url))
const artifacts = path.join(root, "artifacts", "host-roundtrip")
await mkdir(artifacts, { recursive: true })
const fixture = await createFixture()
const profile = await mkdtemp(path.join(tmpdir(), "es-desktop-host-roundtrip-"))
const app = await _electron.launch({
  args: [root],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    OPENCODE_URL: fixture.url,
    ES_DASHBOARD_URL: fixture.url,
    OPENCODE_SERVER_PASSWORD: "",
    ES_DESKTOP_USER_DATA: profile,
    ES_DESKTOP_START: "hidden",
    ES_REMOTE_HOSTS: JSON.stringify([{ id: "mini", label: "Mac Mini", origin: "https://murtaza-mac-mini.tailc81fd.ts.net" }]),
  },
})
const view = async (match) => {
  for (let wait = 50; wait < 20_000; wait *= 2) {
    const found = app.windows().find((item) => match(item.url()))
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
  throw new Error("view not found")
}
const until = async (check, ms, label) => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}
const log = { started: new Date().toISOString() }
try {
  const bar = await view((url) => url.startsWith("data:text/html"))
  const local = await view((url) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(url))
  const localOrigin = new URL(local.url()).origin
  await bar.getByRole("link", { name: "Mac Mini" }).click()
  const mini = await view((url) => url.startsWith("http://127.0.0.1:") && !url.startsWith(localOrigin))
  const origin = new URL(mini.url()).origin
  await mini.goto(`${origin}/new`)
  const form = mini.locator("form.new-session-draft")
  await expect(form.getByLabel("Project")).toBeEnabled({ timeout: 20_000 })
  await form.getByLabel("Project").selectOption("dotfiles")
  const workspaces = await form.getByLabel("Workspace").locator("option").evaluateAll((items) => items.map((item) => item.value))
  log.workspaces = workspaces
  if (workspaces.length > 1 && workspaces.includes(directory)) await form.getByLabel("Workspace").selectOption(directory)
  // The host default agent unless one is named: agent names are per-host configuration.
  await form.getByLabel("Agent").selectOption(process.env.ES_TEST_AGENT ?? "")
  await form.getByLabel("Model").selectOption(model)
  await form.getByLabel("Message").fill(prompt)
  await form.getByRole("button", { name: /Send/ }).click()
  await mini.waitForURL(/\/session\/ses_/, { timeout: 60_000 })
  const id = /\/session\/(ses_[^/?]+)/.exec(mini.url())[1]
  log.session = id
  // The session's own directory, as Core reports it on the Mini.
  log.directory = await until(() => mini.evaluate(([id]) => fetch("/oc/experimental/session?roots=true&archived=true&limit=50")
    .then((r) => r.json()).then((list) => list.find((item) => item.id === id)?.directory), [id]), 30_000, "session listed")
  const messages = () => mini.evaluate(([id, dir]) =>
    fetch(`/oc/session/${id}/message?directory=${encodeURIComponent(dir)}&summaryPatches=false`).then((r) => r.json()), [id, log.directory])
  await until(async () => (await messages()).some((m) => m.parts.some((p) => p.type === "tool" && p.state?.status === "completed")), 240_000, "first tool call")
  log.firstToolAt = new Date().toISOString()
  const active = mini.locator(".float-editor").or(mini.locator(".prompt-box:not([inert])"))
  await active.getByRole("textbox").first().fill(steer)
  await active.getByRole("button", { name: "Steer", exact: true }).click()
  log.steerSentAt = new Date().toISOString()
  await until(async () => (await messages()).some((m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && p.text.includes(steer.slice(0, 40)))), 240_000, "steer promoted into the transcript")
  log.steerVisibleAt = new Date().toISOString()
  await until(async () => {
    const all = await messages()
    const last = all.at(-1)
    return last?.info.role === "assistant" && last.info.time?.completed && !last.parts.some((p) => p.type === "tool" && ["pending", "running"].includes(p.state?.status))
  }, 600_000, "agent finished")
  log.finishedAt = new Date().toISOString()
  const final = await messages()
  log.messageCount = final.length
  log.toolCalls = final.flatMap((m) => m.parts).filter((p) => p.type === "tool").map((p) => `${p.tool}:${p.state?.status}`)
  log.wroteReport = final.flatMap((m) => m.parts).some((p) => p.type === "tool" && p.tool === "write" && String(p.state?.input?.filePath ?? "").endsWith("mini-readiness.md") && p.state?.status === "completed")
  await mini.waitForTimeout(1500)
  await mini.screenshot({ path: path.join(artifacts, "mini-session.png") })
  log.localStillOnLocal = local.url().startsWith(localOrigin)
  log.localFixtureSessions = fixture.sessionIDs
  await writeFile(path.join(artifacts, "result.json"), JSON.stringify(log, null, 2))
  console.log(JSON.stringify(log, null, 2))
} catch (error) {
  log.error = String(error)
  await writeFile(path.join(artifacts, "result.json"), JSON.stringify(log, null, 2))
  console.log(JSON.stringify(log, null, 2))
  throw error
} finally {
  await app.close()
  await fixture.close?.()
}
