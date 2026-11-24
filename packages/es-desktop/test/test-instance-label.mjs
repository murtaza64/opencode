// A second instance on a disposable profile (ES_DESKTOP_USER_DATA) says it is a test instance: a "TEST · <profile>"
// badge in the app header (every window) and the host strip, so it is never mistaken for the normal Editspace.
// Run from packages/es-desktop after `bun run build`: node test/test-instance-label.mjs [--shots DIR]
import { _electron } from "@playwright/test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

const root = path.resolve(import.meta.dirname, "..")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const fixture = await createFixture()
const profile = await mkdtemp(path.join(tmpdir(), "editspace-label-"))
const app = await _electron.launch({
  executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  args: process.env.ES_DESKTOP_EXECUTABLE ? ["--use-mock-keychain"] : [root, "--use-mock-keychain"],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "" },
})
try {
  const label = `TEST · ${path.basename(profile)}`
  const window = await app.firstWindow()
  await window.waitForURL("http://127.0.0.1:*/", { timeout: 60_000 }).catch(() => undefined)
  // The app's own header carries the badge in every window (also a single-host window with no host strip).
  await window.locator(".test-instance-badge").first().waitFor({ timeout: 60_000 })
  const badge = await window.locator(".test-instance-badge").first().textContent()
  assert.equal(badge, label, "app header labels the test instance")
  if (shots) await window.screenshot({ path: path.join(shots, "test-instance-header.png"), clip: { x: 0, y: 0, width: 900, height: 60 } })
  console.log(`PASS test-instance-label: header badge "${badge}"`)
} finally {
  await app.close()
  await fixture.close()
  await rm(profile, { recursive: true, force: true })
}
