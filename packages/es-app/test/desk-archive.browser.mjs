// Porter memory archive (dotfiles#295) beside the memory notes: list docs and session summaries, search, view, edit
// (compare-and-set; a 409 re-reads without overwriting), create and delete; a dashboard without the archive says so.
// LTR and RTL. Disposable routes; nothing reaches a real dashboard. Run from packages/es-app:
// node test/desk-archive.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startAttentionPreview()
const sha = (text) => createHash("sha256").update(text).digest("hex")
const now = Date.now()
const files = new Map([
  ["release-flow", "# Release flow\n\nPublish with the normal publisher; build with ES_RELEASE."],
  ["sessions/2026-11-22-ses_e0649e688ffeM3YMm3i13AVsxL", "Asked: ship .10. Decided: keep .10. Open: mail list fixes."],
])
let present = true
const writes = []
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
page.setDefaultTimeout(90_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/es/api/frontdesk/memory", (route) => route.request().method() === "GET"
  ? route.fulfill({ json: { version: 1, revision: 0, entries: [], history: [] } }) : route.fallback())
await page.route("**/es/api/frontdesk/archive**", async (route) => {
  const request = route.request()
  const url = new URL(request.url())
  if (!present) return route.fulfill({ status: 404, json: { detail: "Not Found" } })
  if (url.pathname === "/es/api/frontdesk/archive") return route.fulfill({ json: { docs: [...files].map(([slug, text]) => ({ slug, path: `archive/${slug}.md`, chars: text.length, updated: now - 60_000 })) } })
  if (url.pathname.endsWith("/search")) return route.fulfill({ json: { results: [...files].filter(([, text]) => text.toLowerCase().includes(url.searchParams.get("q").toLowerCase())).map(([slug]) => ({ slug, path: `archive/${slug}.md`, snippet: "", score: 1 })) } })
  const slug = decodeURIComponent(url.pathname.replace("/es/api/frontdesk/archive/doc/", ""))
  if (request.method() === "GET") return files.has(slug) ? route.fulfill({ json: { slug, path: `archive/${slug}.md`, text: files.get(slug), sha256: sha(files.get(slug)) } }) : route.fulfill({ status: 404, json: { error: `no archive doc ${slug}` } })
  const body = JSON.parse(request.postData())
  writes.push([request.method(), slug, body.expected_sha256])
  if (body.expected_sha256 !== (files.has(slug) ? sha(files.get(slug)) : "")) return route.fulfill({ status: 409, json: { error: "changed since read" } })
  if (request.method() === "DELETE") { files.delete(slug); return route.fulfill({ json: { slug, deleted: true } }) }
  files.set(slug, body.text)
  return route.fulfill({ json: { slug, sha256: sha(body.text) } })
})
try {
  await page.goto(`${preview.url.replace(/\/$/, "")}/desk`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await page.getByRole("button", { name: /^Memory/ }).click({ timeout: 120_000 })
  const panel = page.locator(".desk-archive")
  await panel.locator("summary").click()
  await expect(panel.getByRole("list", { name: "Archive docs" })).toContainText("release-flow")
  await expect(panel.getByRole("list", { name: "Session summaries" })).toContainText("sessions/2026-11-22-ses_e0649e688ffeM3YMm3i13AVsxL")
  await expect(panel.locator("summary")).toHaveText("Archive (2)")

  // View, then edit and save with the read's sha256.
  await panel.getByRole("button", { name: "release-flow" }).click()
  await expect(panel.locator(".desk-archive-text")).toContainText("Publish with the normal publisher")
  await panel.getByRole("button", { name: "Edit" }).click()
  await panel.getByLabel("Edit release-flow").fill("# Release flow\n\nBuild with ES_RELEASE, then publish.")
  if (shots) await page.screenshot({ path: path.join(shots, "archive-edit-ltr.png") })
  await panel.getByRole("button", { name: "Save" }).click()
  await expect(panel).toContainText("Saved release-flow.")
  await expect(panel.locator(".desk-archive-text")).toContainText("Build with ES_RELEASE, then publish.")
  assert.deepEqual(writes.at(-1), ["PUT", "release-flow", sha("# Release flow\n\nPublish with the normal publisher; build with ES_RELEASE.")])

  // Changed elsewhere since it was read: refused, re-read, nothing overwritten.
  await panel.getByRole("button", { name: "Edit" }).click()
  files.set("release-flow", "Changed by the desk meanwhile.")
  await panel.getByLabel("Edit release-flow").fill("my stale edit")
  await panel.getByRole("button", { name: "Save" }).click()
  await expect(panel).toContainText("changed since it was read")
  await expect(panel.locator(".desk-archive-text")).toContainText("Changed by the desk meanwhile.")
  assert.equal(files.get("release-flow"), "Changed by the desk meanwhile.")

  // Search, create and delete (confirmed).
  await panel.getByLabel("Search the archive").fill("keep .10")
  await expect(panel.getByRole("list", { name: "Archive search results" })).toContainText("sessions/2026-11-22")
  await panel.getByLabel("New doc name").fill("porter-hosts")
  await panel.getByLabel("New doc text").fill("Mini is often off; the Laptop is the fallback.")
  await panel.getByRole("button", { name: "Create doc" }).click()
  await expect(panel).toContainText("Created porter-hosts.")
  assert.deepEqual(writes.at(-1), ["PUT", "porter-hosts", ""])
  page.once("dialog", (dialog) => dialog.accept())
  await panel.getByRole("button", { name: "Delete" }).click()
  await expect(panel).toContainText("Deleted porter-hosts.")
  assert.equal(files.has("porter-hosts"), false)

  // RTL mirrors; the paths stay left-to-right.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await panel.getByRole("button", { name: "release-flow" }).click()
  await expect(panel.locator(".desk-archive-doc .desk-archive-slug")).toHaveAttribute("dir", "ltr")
  if (shots) await page.screenshot({ path: path.join(shots, "archive-rtl.png") })
  await page.evaluate(() => { document.documentElement.dir = "ltr" })

  // A dashboard without the archive says so.
  present = false
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: /^Memory/ }).click({ timeout: 120_000 })
  await panel.locator("summary").click()
  await expect(panel).toContainText("This dashboard has no memory archive.")
  assert.deepEqual(errors, [])
  console.log("PASS desk-archive: list docs + summaries, search, view, edit (CAS), 409 re-read, create, delete, absent route, RTL")
} catch (error) {
  console.error(error)
  if (shots) await page.screenshot({ path: path.join(shots, "archive-failure.png") }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close()
}
