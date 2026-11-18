import { _electron, expect } from "@playwright/test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createFixture, directory } from "../../es-app/test/composer-fixture.mjs"

const executable = process.env.ES_DESKTOP_EXECUTABLE
if (!executable) throw Error("Set the exact candidate executable")
const fixture = await createFixture()
fixture.status = "idle"
fixture.permissions = []
fixture.openrouterUsage = {
  schema: "es-openrouter-usage/1", state: "ok", observedAt: new Date().toISOString(),
  credits_usd: 0, external_byok_usd: 37.61, total_inference_usd: 37.61,
  credits_today_utc_usd: 0, external_byok_today_utc_usd: 37.58,
  key_limit_usd: 2000, key_remaining_usd: 2000, include_byok_in_key_limit: false,
  expires_at: "2026-12-17T19:46:00Z",
  effective_budget: { scope: "key_limit", limit_usd: 2000, remaining_usd: 2000, spend_usd: 0, include_byok: false },
}
const profile = await mkdtemp(path.join(tmpdir(), "ori-desktop-release-"))
await writeFile(path.join(profile, "release-notes-seen.json"), JSON.stringify({ release: "2026-11-18.1" }), { mode: 0o600 })
const options = { executablePath: executable, args: ["--use-mock-keychain"], env: {
  ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url,
  ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "", OPENCODE_SERVER_PASSWORD: "",
} }
let app
try {
  app = await _electron.launch(options)
  const page = await app.firstWindow()
  await page.waitForURL("http://127.0.0.1:*/")
  const origin = new URL(page.url()).origin
  await page.goto(`${origin}/usage`)
  const panel = page.getByRole("region", { name: "Inference usage", exact: true })
  await expect(panel.locator(".ori-number")).toHaveText("$37.58")
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "0")
  await expect(panel).toContainText("$2,000.00 left")
  await expect(panel).toContainText("Limit not reported")
  await expect(page.getByRole("link", { name: "Ori today (UTC): $37.58. Open Usage" }).filter({ visible: true })).toBeVisible()
  expect(await page.evaluate(() => fetch("/es/api/usage/openrouter", { method: "POST" }).then((response) => response.status))).toBe(403)
  expect(await page.evaluate(() => fetch("/es/api/usage/openrouter/other").then((response) => response.status))).toBe(403)
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  const editor = page.locator(".prompt-box").getByRole("textbox", { name: "Message", exact: true })
  await editor.fill("Unsent draft across local publication")
  await app.close()
  app = await _electron.launch(options)
  const resumed = await app.firstWindow()
  await resumed.waitForURL("http://127.0.0.1:*/")
  expect(new URL(resumed.url()).origin).toBe(origin)
  await resumed.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await expect(resumed.locator(".prompt-box").getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Unsent draft across local publication")
  expect(fixture.calls.filter((call) => call.method === "POST" && /\/(input|prompt_async)$/.test(call.path))).toHaveLength(0)
  console.log("PASS packaged Ori Usage, native read-only billing route, daily badge, persistent draft after restart, no inference submission")
} finally {
  await app?.close()
  await fixture.close()
  await rm(profile, { recursive: true, force: true })
}
