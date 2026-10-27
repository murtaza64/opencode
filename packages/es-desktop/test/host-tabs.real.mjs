// Native host tabs against the real Mac Mini (read-only requests only) and a page host.
// Local runs against the private composer fixture in a disposable profile; no live laptop state is touched.
// Usage: node test/host-tabs.real.mjs   (after `bun run build`)
import { _electron, expect } from "@playwright/test"
import { mkdtemp, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const artifacts = path.join(root, "artifacts", "host-tabs")
await mkdir(artifacts, { recursive: true })
const fixture = await createFixture()
const profile = await mkdtemp(path.join(tmpdir(), "es-desktop-host-tabs-"))
const mini = process.env.ES_TEST_MINI_ORIGIN ?? "https://murtaza-mac-mini.tailc81fd.ts.net"
const personal = process.env.ES_TEST_PAGE_ORIGIN ?? "https://agents.murtaza.earth"
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
    ES_REMOTE_HOSTS: JSON.stringify([
      { id: "mini", label: "Mac Mini", origin: mini },
      { id: "personal", label: "Personal", origin: personal, mode: "page" },
    ]),
  },
})
const page = async (match) => {
  for (let wait = 50; wait < 20_000; wait *= 2) {
    const found = app.windows().find((item) => match(item.url()))
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
  throw new Error(`No view matching ${match}; views: ${app.windows().map((item) => item.url()).join(", ")}`)
}
const result = {}
try {
  const bar = await page((url) => url.startsWith("data:text/html"))
  const local = await page((url) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(url))
  const localOrigin = new URL(local.url()).origin
  await local.waitForSelector("#root *")
  result.localHost = await local.evaluate(() => fetch("/__es/host").then((response) => response.json()))
  // A local draft written before switching must survive the round trip and stay invisible to the Mini.
  await local.evaluate(() => localStorage.setItem("es-app:host-tabs-check", "local draft"))
  result.tabs = await bar.locator("a").allTextContents()

  await bar.getByRole("link", { name: "Mac Mini" }).click()
  const remote = await page((url) => url.startsWith("http://127.0.0.1:") && !url.startsWith(localOrigin))
  await remote.waitForLoadState("domcontentloaded")
  result.miniOrigin = new URL(remote.url()).origin
  result.miniTitle = await remote.title()
  await remote.waitForSelector("#root *", { timeout: 20_000 })
  result.miniHost = await remote.evaluate(() => fetch("/__es/host").then((response) => response.json()))
  result.miniCapabilities = await remote.evaluate(() => fetch("/oc/experimental/capabilities").then((response) => response.status))
  result.miniEditspaces = await remote.evaluate(() => fetch("/es/api/editspaces").then((response) => response.json()).then((value) => value.editspaces.map((item) => item.name)))
  result.miniSeesLocalDraft = await remote.evaluate(() => localStorage.getItem("es-app:host-tabs-check"))
  result.miniCurrentTab = await bar.locator('a[aria-current="page"]').textContent()
  await new Promise((resolve) => setTimeout(resolve, 2000))
  await remote.screenshot({ path: path.join(artifacts, "mini.png") })

  await bar.getByRole("link", { name: "Personal" }).click()
  const personalPage = await page((url) => url.startsWith("https://"))
  await personalPage.waitForLoadState("domcontentloaded")
  result.personalHost = new URL(personalPage.url()).hostname
  await personalPage.screenshot({ path: path.join(artifacts, "personal.png") })

  await bar.getByRole("link", { name: "Local" }).click()
  result.localDraftAfterRoundTrip = await local.evaluate(() => localStorage.getItem("es-app:host-tabs-check"))
  result.localURLKept = local.url() === `${localOrigin}/`
  await local.screenshot({ path: path.join(artifacts, "local.png") })
  console.log(JSON.stringify(result, null, 2))
  expect(result.tabs).toEqual(["Local", "Mac Mini", "Personal"])
  expect(result.localHost).toMatchObject({ id: "local", remote: false })
  expect(result.miniHost).toMatchObject({ id: "mini", label: "Mac Mini", remote: true })
  expect(result.miniCapabilities).toBe(200)
  expect(result.miniEditspaces).toContain("dotfiles")
  expect(result.miniSeesLocalDraft).toBeNull()
  expect(result.localDraftAfterRoundTrip).toBe("local draft")
  expect(result.personalHost.endsWith("murtaza.earth") || result.personalHost.endsWith("cloudflareaccess.com")).toBe(true)
} finally {
  await app.close()
  await fixture.close?.()
}
