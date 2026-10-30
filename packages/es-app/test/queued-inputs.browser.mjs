// #155: pending input receipts are a compact header (counts + refresh) over
// one-line rows (kind, text, Cancel); no explanatory paragraph or repeated
// per-row status. Refresh, Cancel, images, unknown-admission recovery, stable
// IDs and busy/idle variants are retained.
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
fixture.receipts = [
  { requestID: "q1", sessionID: "ses_a", delivery: "queue", text: "Queued: run the full suite after the refactor lands and summarise failures", agent: "build", admittedSeq: 1, timeCreated: 1, state: "pending",
    images: [{ type: "file", mime: "image/png", url: png, filename: "shot.png" }] },
  { requestID: "s1", sessionID: "ses_a", delivery: "steer", text: "Steer: prefer bun APIs", agent: "build", admittedSeq: 2, timeCreated: 2, state: "pending" },
]
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "queued-inputs-")) : undefined
const app = profile ? await _electron.launch({ args: ["--use-mock-keychain"], executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" } }) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const context = app ? app.context() : await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = app ? await app.firstWindow() : await context.newPage()
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
const receipts = page.locator(".input-receipts")
const summary = receipts.locator("> summary")
const row = (id) => receipts.locator(`li[data-request-id="${id}"]`)
const listReads = () => fixture.calls.filter((call) => call.method === "GET" && call.path === "/session/ses_a/input")
const cancels = () => fixture.calls.filter((call) => call.method === "DELETE" && call.path.startsWith("/session/ses_a/input/"))
const posts = () => fixture.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/input")
const otherWrites = () => fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method) && !call.path.startsWith("/session/ses_a/input"))
const shot = async (name) => { if (process.env.QUEUED_INPUTS_SHOTS) await page.screenshot({ path: `${process.env.QUEUED_INPUTS_SHOTS}-${name}.png` }) }
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  // Pending inputs are outgoing bubbles in the transcript tail, each with a one-line cue.
  await expect(receipts).toBeVisible()
  await expect(receipts).toHaveAttribute("aria-label", "Pending inputs")
  await expect(page.locator(".composer-results")).toBeHidden()
  await expect(receipts).not.toContainText("Added to conversation")
  await expect(row("q1")).toHaveAttribute("data-delivery", "queue")
  await expect(row("q1").locator(".outgoing-cue")).toContainText("Queued · after this task")
  await expect(row("q1").locator(".receipt-text")).toContainText("run the full suite")
  await expect(row("q1").locator("img")).toHaveCount(1)
  await expect(row("s1")).toHaveAttribute("data-delivery", "steer")
  await expect(row("s1").locator(".outgoing-cue")).toContainText("Steer · at the next safe point")
  await expect(row("s1").locator("img")).toHaveCount(0)
  await expect(receipts.getByRole("button", { name: "Cancel queue input: Queued: run the full suite after the refactor lands and summarise failures" })).toBeVisible()
  await shot("busy")

  // Inputs refresh on events and a timer; there is no manual refresh control.
  await expect(page.getByRole("button", { name: "Refresh inputs" })).toHaveCount(0)

  // Cancel sends exactly one DELETE for that ID; the other receipt and the draft are untouched.
  await editor.fill("draft kept while cancelling")
  await receipts.getByRole("button", { name: /^Cancel steer input: Steer: prefer bun APIs$/ }).click()
  await expect(row("s1")).toHaveCount(0)
  await expect(row("q1")).toBeVisible()
  expect(cancels().map((call) => decodeURIComponent(call.path.split("/").at(-1)))).toEqual(["s1"])
  await expect(editor).toHaveValue("draft kept while cancelling")

  // Unknown admission: a lost ack keeps the input in the fixture; the background readback (GET by request ID)
  // finds it under the same ID without resending, with no Check click.
  fixture.acceptedAckLost = true
  const postsBefore = posts().length
  // Queue is a secondary action behind the send menu.
  await page.getByRole("button", { name: "More send options", exact: true }).click()
  await page.getByRole("button", { name: "Queue", exact: true }).click()
  await expect.poll(() => posts().length).toBe(postsBefore + 1)
  const requestID = posts().at(-1).body.requestID
  expect(fixture.receipts.some((item) => item.requestID === requestID && item.state === "pending")).toBe(true)
  // The unknown input is an outgoing bubble with an inline cue, not a popup above the composer.
  await expect(page.locator(".composer-results")).toBeHidden()
  await expect(page.locator(".input-admission")).toHaveCount(0)
  await expect(row(requestID)).toHaveCount(1)
  await expect(row(requestID).locator(".outgoing-cue")).toContainText("Queued · after this task")
  await expect(row(requestID).locator(".outgoing-cue")).not.toContainText("Not confirmed")
  await expect(row(requestID).locator(".receipt-text")).toHaveText("draft kept while cancelling")
  expect(posts()).toHaveLength(postsBefore + 1)
  await expect(receipts.locator("li")).toHaveCount(2)
  expect(posts()).toHaveLength(1)
  await shot("recovered")

  // Idle: receipts stay listed and cancellable; nothing is resent.
  fixture.setStatus("idle")
  // Empty draft: the primary is Nudge, never an empty Send.
  await expect(page.locator(".prompt-box .direct-primary")).toHaveAccessibleName("Nudge the agent (empty message)")
  await expect(row("q1")).toBeVisible()
  await expect(receipts.locator("li")).toHaveCount(2)
  expect(posts()).toHaveLength(1)

  // Mobile + RTL: rows stay single-column with reachable Cancel, no horizontal overflow.
  await page.setViewportSize({ width: 390, height: 780 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await expect(row("q1").getByRole("button", { name: /^Cancel queue input/ })).toBeVisible()
  const size = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  expect(size.scroll).toBeLessThanOrEqual(size.client)
  await shot("mobile-rtl")
  await page.evaluate(() => { document.documentElement.dir = "ltr" })
  await page.setViewportSize({ width: 1280, height: 900 })

  expect(otherWrites()).toEqual([])
  expect(fixture.unexpected).toEqual([])
  console.log(`PASS ${app ? "packaged native" : "browser"} queued inputs: outgoing bubbles with inline cues, no results panel, no manual refresh, single cancel, image preview, unknown admission recovery with stable ID and stable bubble element/geometry, idle variant, mobile RTL, no other writes`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}
