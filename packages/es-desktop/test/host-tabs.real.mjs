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
// Count requests reaching the local fixture, to measure what a hidden host costs.
const counted = []
const { createServer } = await import("node:http")
const counter = createServer((request, response) => {
  counted.push({ at: Date.now(), path: request.url.split("?")[0], method: request.method })
  const upstream = new URL(request.url, fixture.url)
  fetch(upstream, { method: request.method, headers: Object.fromEntries(Object.entries(request.headers).filter(([key]) => key !== "host")), body: ["GET", "HEAD"].includes(request.method) ? undefined : request, duplex: "half" })
    .then(async (reply) => {
      response.writeHead(reply.status, Object.fromEntries(reply.headers))
      if (!reply.body) return response.end()
      for await (const chunk of reply.body) response.write(chunk)
      response.end()
    })
    .catch(() => response.destroy())
})
await new Promise((resolve) => counter.listen(0, "127.0.0.1", resolve))
const counterURL = `http://127.0.0.1:${counter.address().port}`
const profile = await mkdtemp(path.join(tmpdir(), "es-desktop-host-tabs-"))
const mini = process.env.ES_TEST_MINI_ORIGIN ?? "https://murtaza-mac-mini.tailc81fd.ts.net"
const personal = process.env.ES_TEST_PAGE_ORIGIN ?? "https://agents.murtaza.earth"
const app = await _electron.launch({
  args: [root, "--use-mock-keychain"],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    OPENCODE_URL: counterURL,
    ES_DASHBOARD_URL: counterURL,
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
// The strip repaints by navigating to a new data: page; retry reads that race a repaint.
const settled = async (read) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read()
    } catch (error) {
      if (attempt > 8 || !String(error).includes("context was destroyed")) throw error
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}
try {
  const bar = await page((url) => url.startsWith("data:text/html"))
  // The strip repaints (a data: navigation) when the first host summaries arrive.
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const local = await page((url) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(url))
  const localOrigin = new URL(local.url()).origin
  await local.waitForSelector("#root *")
  result.localHost = await local.evaluate(() => fetch("/__es/host").then((response) => response.json()))
  // A local draft written before switching must survive the round trip and stay invisible to the Mini.
  await local.evaluate(() => localStorage.setItem("es-app:host-tabs-check", "local draft"))
  result.tabs = await settled(() => bar.locator("a bdi").allTextContents())
  result.initialTab = await settled(() => bar.locator('a[aria-current="page"] bdi').textContent())
  // One title bar: the strip ends where the app header's content begins, same row and height.
  result.strip = await settled(() => bar.evaluate(() => ({ width: innerWidth, height: innerHeight, tabs: [...document.querySelectorAll("a")].map((a) => ({ text: a.textContent, right: Math.round(a.getBoundingClientRect().right) })) })))
  await local.waitForFunction(() => document.querySelector(".native-header-safe"), null, { timeout: 15_000 })
  result.localHeader = await local.evaluate(() => {
    const safe = document.querySelector(".native-header-safe").getBoundingClientRect()
    const header = document.querySelector(".native-header").getBoundingClientRect()
    return { top: header.top, height: header.height, safeLeft: Math.round(safe.left), drag: getComputedStyle(document.querySelector(".native-header")).webkitAppRegion ?? getComputedStyle(document.querySelector(".native-header")).getPropertyValue("-webkit-app-region") }
  })
  await bar.screenshot({ path: path.join(artifacts, "strip.png") })
  await local.screenshot({ path: path.join(artifacts, "local-top.png"), clip: { x: 0, y: 0, width: 1440, height: 44 } })
  result.badgesAfterFirstRead = await (async () => {
    for (let i = 0; i < 40; i++) {
      const marks = await bar.locator("b").allTextContents()
      if (marks.length || i > 20) return { marks, labels: await bar.locator("b").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label"))) }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  })()

  // Physical Work hosts open from the Hosts menu; the Work tab already shows their rows.
  const openHost = (label) => app.evaluate(({ Menu }, label) => Menu.getApplicationMenu().items.find((item) => item.label === "Hosts").submenu.items.find((item) => item.label === label).click(), label)
  result.hostsMenu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((item) => item.label === "Hosts").submenu.items.filter((item) => item.type !== "separator").map((item) => item.label))
  await openHost("Mac Mini")
  const remote = await page((url) => url.startsWith("http://127.0.0.1:") && !url.startsWith(localOrigin))
  await remote.waitForLoadState("domcontentloaded")
  result.miniOrigin = new URL(remote.url()).origin
  result.miniTitle = await remote.title()
  await remote.waitForSelector("#root *", { timeout: 20_000 })
  result.miniHost = await remote.evaluate(() => fetch("/__es/host").then((response) => response.json()))
  result.miniCapabilities = await remote.evaluate(() => fetch("/oc/experimental/capabilities").then((response) => response.status))
  result.miniEditspaces = await remote.evaluate(() => fetch("/es/api/editspaces").then((response) => response.json()).then((value) => value.editspaces.map((item) => item.name)))
  result.miniSeesLocalDraft = await remote.evaluate(() => localStorage.getItem("es-app:host-tabs-check"))
  result.miniCurrentTab = await settled(() => bar.locator('a[aria-current="page"] bdi').textContent())
  result.tabsWhileMini = await settled(() => bar.locator("a bdi").allTextContents())
  result.miniHeader = await remote.evaluate(() => Math.round(document.querySelector(".native-header-safe")?.getBoundingClientRect().left ?? -1))
  await new Promise((resolve) => setTimeout(resolve, 2000))
  await remote.screenshot({ path: path.join(artifacts, "mini.png") })

  await bar.getByRole("link", { name: "Personal" }).click()
  const personalPage = await page((url) => url.startsWith("https://"))
  await personalPage.waitForLoadState("domcontentloaded")
  result.personalHost = new URL(personalPage.url()).hostname
  await personalPage.screenshot({ path: path.join(artifacts, "personal.png") })
  result.personalStrip = await bar.evaluate(() => innerWidth)

  await bar.getByRole("link", { name: "Work" }).click()
  const geometry = async () => {
    await new Promise((resolve) => setTimeout(resolve, 600))
    return {
      strip: await settled(() => bar.evaluate(() => ({ width: innerWidth, links: [...document.querySelectorAll("a")].map((a) => a.textContent) }))),
      header: await local.evaluate(() => ({
        zoom: devicePixelRatio,
        safeLeft: Math.round(document.querySelector(".native-header-safe").getBoundingClientRect().left),
        headerHeight: document.querySelector(".native-header").getBoundingClientRect().height,
        contentTop: Math.round(document.querySelector(".shell")?.getBoundingClientRect().top ?? -1),
        hostSwitchHidden: [...document.querySelectorAll(".host-switch")].every((item) => getComputedStyle(item).display === "none"),
      })),
    }
  }
  result.wide = await geometry()
  // OS clicks on the strip must not land in a drag region of the app view under it.
  result.dragUnderTabs = await settled(async () => {
    const points = await bar.evaluate(() => [...document.querySelectorAll("a")].map((a) => { const r = a.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] }))
    return local.evaluate((points) => points.map(([x, y]) => {
      for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
        const region = getComputedStyle(el).getPropertyValue("-webkit-app-region") || getComputedStyle(el).webkitAppRegion
        if (region === "drag" || region === "no-drag") return region
      }
      return "none"
    }), points)
  })
  await bar.screenshot({ path: path.join(artifacts, "strip.png") })
  await local.screenshot({ path: path.join(artifacts, "local-top.png"), clip: { x: 0, y: 0, width: 1440, height: 44 } })
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setContentSize(760, 900))
  result.narrow = await geometry()
  await bar.screenshot({ path: path.join(artifacts, "strip-760.png") })
  await local.screenshot({ path: path.join(artifacts, "local-top-760.png"), clip: { x: 0, y: 0, width: 760, height: 44 } })
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setContentSize(1440, 900))
  await local.evaluate(() => {}) // settle
  // Cmd+= twice and once more: 1.0 -> 1.3 through the app's own zoom items.
  for (let i = 0; i < 3; i++) await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("zoomin").click())
  result.zoomed = await geometry()
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("resetzoom").click())
  // Idle budget while another host is shown: requests the hidden Local host makes in 65 s.
  await openHost("Mac Mini")
  const t0 = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 65_000))
  const window = counted.filter((item) => item.at >= t0)
  result.idleLocalWhileHidden = { seconds: Math.round((Date.now() - t0) / 1000), requests: window.length, byPath: Object.entries(window.reduce((all, item) => ({ ...all, [`${item.method} ${item.path}`]: (all[`${item.method} ${item.path}`] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]).slice(0, 12) }
  result.badgeLocalFromMini = await settled(() => bar.locator("a", { hasText: "Work" }).locator("b").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label"))))
  await bar.getByRole("link", { name: "Work" }).click()
  result.localDraftAfterRoundTrip = await local.evaluate(() => localStorage.getItem("es-app:host-tabs-check"))
  result.localURLKept = local.url() === `${localOrigin}/`
  await local.screenshot({ path: path.join(artifacts, "local.png") })
  console.log(JSON.stringify(result, null, 2))
  expect(result.tabs).toEqual(["Work", "Personal"])
  expect(result.hostsMenu).toEqual(["Work", "Mac Mini", "Personal", "Pair a Phone"])
  expect(result.miniCurrentTab).toBe("Mac Mini")
  expect(result.tabsWhileMini).toEqual(["Work", "Mac Mini", "Personal"])
  expect(result.initialTab).toBe("Work")
  expect(result.dragUnderTabs.every((region) => region !== "drag")).toBe(true)
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
  counter.close()
}
