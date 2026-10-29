// Front desk request UX: edit permissions lead with path + controls and a rendered diff, stale or
// unverifiable requests say so without reply controls, and URLs in request bodies are real links.
// Run from packages/es-app: node test/permission-request.browser.mjs
import { createRequire } from "node:module"
import path from "node:path"
import { tmpdir } from "node:os"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const artifacts = process.env.PERMISSION_REQUEST_ARTIFACTS ?? tmpdir()
const preview = await startAttentionPreview()
const fixture = preview.fixture
const file = `${directory}/runtime-options/REPLACEMENT.md`
const editDiff = `Index: ${file}\n===================================================================\n--- ${file}\n+++ ${file}\n@@ -1,4 +1,5 @@\n # Replacement\n-Blank on select comes from OpenCode.\n+Blank on select comes from es-app remounts.\n+Keep recent session stores across navigation.\n \n Decision pending.\n`
const edit = { id: "per_edit", sessionID: "ses_b", permission: "edit", patterns: ["runtime-options/REPLACEMENT.md"], always: ["*"], metadata: { filepath: file, diff: editDiff } }
const patch = { id: "per_patch", sessionID: "ses_b", permission: "edit", patterns: ["src/new.ts", "src/gone.ts"], always: ["*"], metadata: {
  filepath: "src/new.ts, src/gone.ts", diff: "(total)",
  files: [
    { filePath: `${directory}/src/new.ts`, relativePath: "src/new.ts", type: "add", patch: "Index: src/new.ts\n===\n--- src/new.ts\n+++ src/new.ts\n@@ -0,0 +1,2 @@\n+export const a = 1\n+export const b = 2\n", additions: 2, deletions: 0 },
    { filePath: `${directory}/src/gone.ts`, relativePath: "src/gone.ts", type: "delete", patch: "Index: src/gone.ts\n===\n--- src/gone.ts\n+++ src/gone.ts\n@@ -1,1 +0,0 @@\n-export const gone = true\n", additions: 0, deletions: 1 },
  ],
} }
const bash = (id, command) => ({ id, sessionID: "ses_b", permission: "bash", patterns: [command], always: [`${command.split(" ")[0]} *`], metadata: { command, description: `Synthetic ${id}` } })
fixture.strictPermissionReply = true
const big = { ...edit, id: "per_big", patterns: [`docs/${"very-long-directory-name/".repeat(6)}GENERATED.md`], metadata: { filepath: `${directory}/docs/GENERATED.md`, diff: `Index: x\n===\n--- x\n+++ x\n@@ -0,0 +1,500 @@\n${Array.from({ length: 500 }, (_, i) => `+line ${i}`).join("\n")}\n` } }
const empty = { ...edit, id: "per_empty", patterns: ["EMPTY.md"], metadata: { filepath: `${directory}/EMPTY.md`, diff: "Index: EMPTY.md\n===================================================================\n--- EMPTY.md\n+++ EMPTY.md\n" } }
fixture.permissions = [edit, patch, big, empty, bash("per_bash", "bun lint")]
const easel = "http://localhost:5191/workspace/runtime-options?view=board"
const sessionLink = `http://127.0.0.1:3181/session/ses_b?directory=${encodeURIComponent(directory)}`
preview.ledger.records[0].context = `Easel built the workspace at ${easel}. Thread: ${sessionLink}. Synthetic, not approval.`

const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 640 } })
const external = []
await context.route("**/*", (route) => {
  if (new URL(route.request().url()).origin === preview.origin) return route.continue()
  external.push(route.request().url())
  return route.abort()
})
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const replies = []
page.on("request", (request) => {
  const match = /\/oc\/permission\/([^/]+)\/reply\?/.exec(request.url())
  if (match && request.method() === "POST") replies.push(match[1])
})
const card = (id) => page.locator(`.home-permission[data-request-id="${id}"]`)
const queued = (id) => page.locator(`nav.sidebar [data-nav-item="permission:${directory}:${id}"]`)
const select = async (id) => { await queued(id).click(); await expect(card(id)).toBeVisible() }
const refresh = () => page.getByRole("button", { name: "Refresh", exact: true }).click()
const top = async (locator) => (await locator.boundingBox()).y
try {
  // A cold Vite dependency optimization on a loaded machine can delay the first response.
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(queued("per_edit")).toBeVisible({ timeout: 90_000 })

  // Edit: path then controls at the top, then a rendered diff, never the raw unified diff in metadata.
  await select("per_edit")
  const path0 = card("per_edit").locator(".home-edit-files .home-edit-path")
  await expect(path0).toHaveText("runtime-options/REPLACEMENT.md")
  await expect(path0.locator("b")).toHaveText("REPLACEMENT.md")
  await expect(path0).toHaveAttribute("title", file)
  await expect(card("per_edit").locator(".home-edit-files")).toContainText("+2 −1")
  const allow = card("per_edit").getByRole("button", { name: "Allow once", exact: true })
  await expect(allow).toBeEnabled()
  await expect(allow).toBeInViewport()
  const diff = card("per_edit").locator(".home-edit-diff")
  await expect(diff).toHaveAttribute("open", "")
  await expect(diff).toContainText("Blank on select comes from es-app remounts.")
  await expect(diff).toContainText("Blank on select comes from OpenCode.")
  await expect(card("per_edit").locator(".home-edit-raw")).toHaveCount(0)
  expect(await top(allow)).toBeLessThan(await top(diff))
  expect(await top(path0)).toBeLessThan(await top(allow))
  // Added and removed lines keep their structure in the renderer.
  expect(await diff.evaluate((element) => {
    const all = [element, ...element.querySelectorAll("*")].flatMap((node) => node.shadowRoot ? [node, ...node.shadowRoot.querySelectorAll("*")] : [node])
    return ["addition", "deletion"].map((kind) => all.some((node) => [...node.attributes ?? []].some((attr) => `${attr.name}=${attr.value}`.includes(kind))))
  })).toEqual([true, true])
  await expect(card("per_edit").locator(".home-permission-more")).not.toHaveAttribute("open", "")
  await expect(card("per_edit").locator(".home-permission-more dt")).toHaveText(["Directory"])
  await page.screenshot({ path: path.join(artifacts, "permission-edit.png") })

  // Multiple files: each path with its kind and counts, each with its own diff.
  await select("per_patch")
  await expect(card("per_patch").locator(".home-edit-files li")).toHaveCount(2)
  await expect(card("per_patch").locator(".home-edit-files li").nth(0)).toContainText("new file")
  await expect(card("per_patch").locator(".home-edit-files li").nth(1)).toContainText("delete")
  await expect(card("per_patch").locator(".home-edit-diff")).toHaveCount(2)
  await expect(card("per_patch").locator(".home-edit-diff").nth(0)).toContainText("export const b = 2")
  await expect(card("per_patch").locator(".home-edit-diff").nth(1)).toContainText("export const gone = true")

  // A large diff starts folded below reachable controls; an empty file says it has no line changes.
  await select("per_big")
  await expect(card("per_big").locator(".home-edit-diff")).not.toHaveAttribute("open", "")
  await expect(card("per_big").locator(".home-edit-files")).toContainText("+500 −0")
  await expect(card("per_big").getByRole("button", { name: "Reject", exact: true })).toBeInViewport()
  await card("per_big").locator(".home-edit-diff > summary").click()
  await expect(card("per_big").locator(".home-edit-diff")).toContainText("line 0")
  await select("per_empty")
  await expect(card("per_empty").locator(".home-edit-diff")).toContainText("No line changes.")

  // Answered elsewhere: once the source no longer lists it, the card says so and offers no reply.
  await select("per_bash")
  await expect(card("per_bash").getByRole("button", { name: "Allow once", exact: true })).toBeEnabled()
  fixture.permissions = [edit, patch, big, empty]
  await refresh()
  await expect(queued("per_bash")).toHaveCount(0)
  await expect(card("per_bash").locator(".home-permission-state")).toHaveText("No longer waiting for you. It was answered or withdrawn elsewhere; open the thread to see which.")
  await expect(card("per_bash").locator(".home-permission-state").getByRole("link", { name: "open the thread" })).toHaveAttribute("href", /ses_b/)
  await expect(card("per_bash").locator(".home-actions button")).toHaveCount(0)
  await expect(page.locator(".desk-evidence .home-warning")).toHaveCount(0)
  await expect(card("per_bash")).not.toContainText("Allowed")
  await expect(card("per_bash")).not.toContainText("approved")

  // Source unreachable: replies pause; Check again restores controls once the request is confirmed pending.
  fixture.permissions = [edit, patch, big, empty, bash("per_offline", "bun build")]
  await refresh()
  await select("per_offline")
  fixture.failPermissionList = true
  await refresh()
  await expect(queued("per_offline")).toHaveCount(0)
  await expect(card("per_offline").locator(".home-permission-state")).toContainText("Can't reach this project.")
  await expect(card("per_offline").locator(".home-actions button")).toHaveCount(0)
  fixture.failPermissionList = false
  await card("per_offline").getByRole("button", { name: "Check again" }).click()
  await expect(card("per_offline").getByRole("button", { name: "Allow once", exact: true })).toBeEnabled()
  await expect(card("per_offline").locator(".home-permission-state")).toHaveCount(0)

  // Replying from here says what was sent, not "answered elsewhere".
  await card("per_offline").getByRole("button", { name: "Reject", exact: true }).click()
  await expect(card("per_offline").locator(".home-permission-status")).toHaveText("Rejected from here.")
  await expect(card("per_offline").locator(".home-permission-state")).toHaveCount(0)
  await expect(card("per_offline").locator(".home-actions button")).toHaveCount(0)
  expect(replies).toEqual(["per_offline"])

  // RTL phone width: the path stays LTR and the controls stay above the diff and reachable.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await page.setViewportSize({ width: 390, height: 700 })
  await select("per_edit")
  await expect(card("per_edit").locator(".home-edit-files .home-edit-path")).toHaveAttribute("dir", "ltr")
  await card("per_edit").getByRole("button", { name: "Reject", exact: true }).scrollIntoViewIfNeeded()
  await expect(card("per_edit").getByRole("button", { name: "Reject", exact: true })).toBeInViewport()
  expect(await top(card("per_edit").getByRole("button", { name: "Reject", exact: true }))).toBeLessThan(await top(card("per_edit").locator(".home-edit-diff")))
  await page.screenshot({ path: path.join(artifacts, "permission-edit-mobile-rtl.png"), fullPage: true })
  await page.evaluate(() => { document.documentElement.dir = "ltr" })
  await page.setViewportSize({ width: 1280, height: 640 })

  // Links in request bodies: an external URL opens outside the app, an es-app session link navigates in place.
  await page.locator('nav.sidebar [data-nav-item="attention:fixture:decision_1"]').click()
  const body = page.locator(".home-decision[data-attention-id=decision_1]")
  const link = body.getByRole("link", { name: easel })
  await expect(link).toHaveAttribute("href", easel)
  await expect(link).toHaveAttribute("target", "_blank")
  const popup = context.waitForEvent("page")
  await link.click()
  await (await popup).close()
  await expect.poll(() => external.includes(easel)).toBe(true)
  expect(new URL(page.url()).pathname).toBe("/")
  const pages = context.pages().length
  await body.getByRole("link", { name: sessionLink }).click()
  await expect.poll(() => { const url = new URL(page.url()); return url.pathname + url.search }).toBe(`/session/ses_b?directory=${encodeURIComponent(directory)}`)
  expect(context.pages().length).toBe(pages)
  expect(external.some((url) => url.startsWith("http://127.0.0.1:3181"))).toBe(false)
  expect(errors).toEqual([])
  console.log(`PASS permission request UX; screenshots in ${artifacts}`)
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, "permission-request-failure.png"), fullPage: true }).catch(() => undefined)
  console.error(error, errors)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close()
}
