import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { createFixture, directory } from "./composer-fixture.mjs"
import { warmVite } from "./composer-panel-preview.mjs"

// @ Add context slice 1 (mention CONTRACT): grouped agents + sessions picker, chips above the editor,
// readable labels in the text, context parts on one plain send, no reads per keystroke, no writes before send.
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-context-picker")
mkdirSync(shots, { recursive: true })
const fixture = await createFixture()
const mentioned = `ses_${"O".repeat(26)}`
const sameA = `ses_${"A".repeat(26)}`
const sameB = `ses_${"B".repeat(26)}`
const unknown = `ses_${"z".repeat(26)}`
fixture.status = "idle"
fixture.workspaceSessions = [
  { id: sameA, title: "Same title", directory: "/project/alpha", projectID: "", time: { created: 1, updated: Date.now() - 100 } },
  { id: sameB, title: "Same title", directory: "/project/beta", projectID: "", time: { created: 1, updated: Date.now() - 200 } },
]
fixture.sessionIDs = ["ses_a", mentioned]
fixture.sessionTitles.set(mentioned, "Orchestrator main")
fixture.sessionTimes.set(mentioned, { created: 1, updated: Date.now() })
// The lane record is the agent's logical identity; its activity comes from the lane, never the title.
fixture.laneOwners = [{ lane: "orchestrator", owner: mentioned, status: "active", activity: "routing perf pins" }]
fixture.handoffs = [{ lane: "orchestrator", predecessor: `ses_${"P".repeat(26)}`, successor: mentioned }]
process.env.OPENCODE_URL = fixture.url
process.env.ES_DASHBOARD_URL = fixture.url
const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { host: "127.0.0.1", port: 0 } })
await vite.listen()
await warmVite(`http://127.0.0.1:${vite.httpServer.address().port}`, fixture)
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const errors = []
const reads = () => fixture.calls.filter((call) => call.method === "GET" && (call.path.endsWith("/message") || call.path === `/session/${mentioned}`)).length
const writes = () => fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))
try {
  for (const dir of ["ltr", "rtl"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on("pageerror", (error) => errors.push(error.message))
    if (dir === "rtl") await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { document.documentElement.dir = "rtl" }))
    await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const editor = () => page.locator(".prompt-box:not([inert]) textarea")
    const picker = () => page.locator(".prompt-box .context-picker")
    const chips = () => page.locator(".prompt-box .context-chip")
    await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
    await page.evaluate(() => localStorage.clear())
    const loads = fixture.calls.filter((call) => call.path === "/session/ses_a/message").length
    await page.reload()
    await expect(editor()).toBeVisible()
    await expect(page.locator(`.sidebar a[href*="/session/${mentioned}"]`).first()).toBeVisible()
    await expect.poll(() => fixture.calls.filter((call) => call.path === "/session/ses_a/message").length).toBeGreaterThan(loads)
    // Load-time refetches settle first; the baseline covers only the picker interaction.
    for (let last = -1; last !== reads();) { last = reads(); await page.waitForTimeout(500) }
    const baselineReads = reads()
    const baselineWrites = writes().length

    // Groups in contract order; the agent row comes from the lane record; this session is never offered.
    await editor().pressSequentially("ask @orch")
    await expect(picker().getByRole("group")).toHaveCount(2)
    await expect(picker().getByRole("group").first()).toHaveAttribute("aria-label", "Agents")
    await expect(picker().getByRole("group", { name: "Agents" }).getByRole("option")).toHaveText([/orchestrator/])
    await expect(picker().getByRole("group", { name: "Sessions" }).getByRole("option")).toHaveText([/Orchestrator main/])
    await expect(picker().getByRole("option", { name: /Composer fixture/ })).toHaveCount(0)
    // The preview states exactly what will be attached.
    await expect(picker().locator(".context-picker-preview")).toContainText("routing perf pins")
    await expect(picker().locator(".context-picker-preview")).toContainText("Adds: agent identity")
    // Tab jumps to the next group; Enter adds without sending.
    await editor().press("Tab")
    await expect(picker().getByRole("group", { name: "Sessions" }).getByRole("option").first()).toHaveAttribute("aria-selected", "true")
    await expect(picker().locator(".context-picker-preview")).toContainText("Adds: exact session")
    await editor().press("Shift+Tab")
    await expect(picker().getByRole("group", { name: "Agents" }).getByRole("option").first()).toHaveAttribute("aria-selected", "true")
    await page.screenshot({ path: join(shots, `picker-${dir}.png`) })
    await editor().press("Enter")
    await expect(picker()).toHaveCount(0)
    await expect(editor()).toHaveValue("ask @orchestrator ")
    await expect(chips()).toHaveCount(1)
    await expect(chips().first()).toContainText("Agent")
    await expect(chips().first()).toContainText("orchestrator")
    await expect(chips().first()).toHaveAttribute("title", /^Adds: agent identity/)

    // The second item is the exact session; an attached item is not offered again.
    await editor().pressSequentially("and @orch")
    await expect(picker().getByRole("group", { name: "Agents" })).toHaveCount(0)
    await editor().press("Enter")
    await expect(editor()).toHaveValue("ask @orchestrator and @Orchestrator main ")
    await expect(chips()).toHaveText([/Agent\s*orchestrator/, /Session\s*Orchestrator main/])

    // Ranking keeps same-titled sessions apart by recency; Ctrl+N/P move; Esc closes, a second Esc enters Vim normal.
    await editor().pressSequentially(" @same")
    const same = picker().getByRole("option")
    await expect(same).toHaveCount(2)
    await editor().press("Control+n")
    await expect(same.nth(1)).toHaveAttribute("aria-selected", "true")
    await editor().press("Control+p")
    await expect(same.nth(0)).toHaveAttribute("aria-selected", "true")
    await editor().press("Escape")
    await expect(picker()).toHaveCount(0)
    await editor().press("Escape")
    await expect(editor()).toHaveClass(/vim-normal/)
    await editor().press("@")
    await expect(picker()).toHaveCount(0)
    await editor().press("i")
    expect(reads()).toBe(baselineReads)
    expect(writes().slice(baselineWrites).map((call) => `${call.method} ${call.path}`)).toEqual([])

    // Chips survive reload; × removes one; Backspace on an empty editor removes the last.
    await page.reload()
    await expect(chips()).toHaveCount(2)
    await page.getByRole("button", { name: "Remove context Orchestrator main" }).click()
    await expect(chips()).toHaveCount(1)
    await editor().fill("")
    await editor().focus()
    await editor().press("Backspace")
    await expect(chips()).toHaveCount(0)

    // A plain send to an idle agent carries one synthetic context part per chip and clears them.
    await editor().pressSequentially("ask @orch")
    await editor().press("Enter")
    await editor().pressSequentially("about it")
    await page.screenshot({ path: join(shots, `chips-${dir}.png`) })
    const sends = fixture.calls.filter((call) => call.path === "/session/ses_a/prompt_async").length
    await editor().press("Control+Enter")
    await expect.poll(() => fixture.calls.filter((call) => call.path === "/session/ses_a/prompt_async").length).toBe(sends + 1)
    const body = fixture.calls.filter((call) => call.path === "/session/ses_a/prompt_async").at(-1).body
    expect(body.parts[0]).toEqual({ type: "text", text: "ask @orchestrator about it" })
    const context = body.parts.filter((part) => part.metadata?.source === "es-app/mention")
    expect(context).toHaveLength(1)
    expect(context[0].synthetic).toBe(true)
    expect(context[0].metadata.key).toBe(`agent:${new URL(origin).host}:fixture/orchestrator`)
    expect(context[0].text).toContain(`Current session: ${mentioned}`)
    expect(JSON.parse(context[0].text.split("Reference: ")[1])).toMatchObject({ kind: "agent", id: "fixture/orchestrator", host: new URL(origin).host })
    await expect(chips()).toHaveCount(0)
    // Adding context never mails or notifies: the only write is the send itself.
    expect(writes().slice(baselineWrites).map((call) => call.path)).toEqual(["/session/ses_a/prompt_async"])

    // Transcript session references still resolve and navigate.
    const info = { id: `msg_zmention${dir}`, sessionID: "ses_a", role: "assistant", agent: "build", parentID: "msg_user", providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: Date.now() } }
    fixture.emit("message.updated", { info })
    fixture.emit("message.part.updated", { part: { id: `part_mention${dir}`, messageID: info.id, sessionID: "ses_a", type: "text", text: `See @${mentioned} and ${unknown}` } })
    const resolved = page.locator(`.transcript .session-ref[data-session="${mentioned}"][data-resolved="1"]`)
    await expect(resolved).toContainText("@Orchestrator main")
    await expect(page.locator(`.transcript .session-ref[data-session="${unknown}"][data-unknown="1"]`)).toBeVisible()
    await page.close()
  }
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  console.log(`PASS context picker: grouped agents + sessions, preview bound, Tab groups, chips, readable labels, persistence, removal, one-send context parts, no reads/writes before send, LTR/RTL; screenshots ${shots}`)
} finally {
  await browser.close()
  await vite.close()
  await fixture.close()
}
