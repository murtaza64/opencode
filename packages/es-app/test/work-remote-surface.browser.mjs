// Another Work host's Surface opened in this window fills the centre pane (Laptop2547): the frame's height follows the
// pane at two window sizes and after a resize, the pane itself does not scroll (so the sticky header never overlaps
// the title), and the frame owns scrolling of a tall artifact, by keyboard too. Compared against this host's own
// Surface reader on the same artifact. Disposable fixture. Run from packages/es-app: node test/work-remote-surface.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const miniOrigin = "http://127.0.0.1:65032"
const now = Date.now()
const surface = { id: "srf_spec", title: "Diff stream spec", summary: null, kind: "path", owner: "diff-stream", lane: null, editspace: "fixture", updated_at: now - 5_000, revision: 1, health: { state: "ok" } }
// A tall artifact with its own sticky nav, like a spec page.
const ARTIFACT = `<!doctype html><style>body{margin:0;font:14px sans-serif}nav{position:sticky;top:0;background:#333;color:#fff;padding:8px}p{margin:0;padding:8px;height:40px}</style>
<nav>Spec nav</nav>${Array.from({ length: 80 }, (_, index) => `<p>Section ${index + 1}</p>`).join("")}`
await page.route(url => { const u = new URL(url); return u.origin !== preview.origin && u.origin !== miniOrigin }, route => route.abort())
await page.route("**/__es/host", route => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.fixture.url }, { id: "mini", label: "Mac Mini", origin: miniOrigin }] } }))
// This host's own copy of the same artifact, for comparison with its own Surface reader.
await page.route(`${preview.url}/es/api/surfaces`, route => route.fulfill({ json: { surfaces: [{ ...surface, id: "srf_local", title: "Diff stream spec (local)" }] } }))
await page.route(`${preview.url}/__es/surface/srf_local`, route => route.fulfill({ json: { src: "/__es/frame/srf_local", expires_at: Date.now() + 600_000 } }))
await page.route(`${preview.url}/__es/frame/srf_local`, route => route.fulfill({ contentType: "text/html", body: ARTIFACT }))
await page.route(`${miniOrigin}/**`, route => route.fulfill({ contentType: "text/html", body: "<title>Mini</title>" }))
await page.route("**/hosts/mini/**", route => {
  const path = new URL(route.request().url()).pathname.replace(/^\/hosts\/mini/, "")
  if (path === "/es/api/surfaces") return route.fulfill({ json: { surfaces: [surface] } })
  if (path === "/__es/surface/srf_spec") return route.fulfill({ json: { src: "/hosts/mini/__es/frame/srf_spec", expires_at: Date.now() + 600_000 } })
  if (path === "/__es/frame/srf_spec") return route.fulfill({ contentType: "text/html", body: ARTIFACT })
  if (path === "/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: "/Users/mini/fixture/.editspace" }], default: "fixture" } })
  if (path === "/es/api/attention") return route.fulfill({ json: { records: [], projects: [], partial: false, limit: 200 } })
  return route.fulfill({ json: [] })
})
const detail = page.locator(".work-remote")
// Pane = the selected-item section; the frame should take everything below the section's header and title.
const measure = () => detail.evaluate((section) => {
  const frame = section.querySelector("iframe.desk-surface-frame")
  const box = (element) => element.getBoundingClientRect()
  return { pane: Math.round(box(section).height), paneBottom: Math.round(box(section).bottom), frame: Math.round(box(frame).height), frameBottom: Math.round(box(frame).bottom),
    paneScrolls: section.scrollHeight > section.clientHeight + 1, headBottom: Math.round(box(section.querySelector(".desk-evidence-head")).bottom),
    titleTop: Math.round(box(section.querySelector(".work-remote-surface h2")).top) }
})
const results = {}
try {
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await page.locator("nav.sidebar").getByRole("tab", { name: /^Surfaces/ }).click()
  // This host's own Surface reader on the same artifact fills the pane the same way.
  const local = page.locator("nav.sidebar [data-nav-item='surface:srf_local']")
  await expect(local).toBeVisible({ timeout: 120_000 })
  await local.click()
  const localPane = page.locator(".desk-evidence.desk-surface")
  await expect(localPane.locator("iframe.desk-surface-frame")).toBeVisible()
  results.local = await localPane.evaluate((section) => ({ pane: Math.round(section.getBoundingClientRect().height), frameBottom: Math.round(section.querySelector("iframe").getBoundingClientRect().bottom), paneBottom: Math.round(section.getBoundingClientRect().bottom) }))
  console.log("local", JSON.stringify(results.local))
  expect(Math.abs(results.local.frameBottom - results.local.paneBottom)).toBeLessThanOrEqual(2)
  expect(results.local.pane).toBeGreaterThan(850)
  const row = page.locator("nav.sidebar [data-nav-item='mini~surface:srf_spec']")
  await expect(row).toBeVisible({ timeout: 120_000 })
  await row.click()
  await expect(detail.locator("iframe.desk-surface-frame")).toBeVisible()
  const frame = page.frameLocator(".work-remote iframe.desk-surface-frame")
  await expect(frame.locator("nav")).toHaveText("Spec nav")
  for (const [name, size] of [["1280x900", { width: 1280, height: 900 }], ["1600x1000", { width: 1600, height: 1000 }], ["resized 1100x700", { width: 1100, height: 700 }]]) {
    await page.setViewportSize(size)
    await page.waitForTimeout(200)
    const value = await measure()
    results[name] = value
    console.log(name, JSON.stringify(value))
    // The frame reaches the bottom of the pane and the pane does not scroll; the header stays above the title.
    expect(Math.abs(value.frameBottom - value.paneBottom), `${name}: frame bottom ${value.frameBottom} vs pane bottom ${value.paneBottom}`).toBeLessThanOrEqual(2)
    expect(value.paneScrolls, `${name}: the pane scrolls`).toBe(false)
    expect(value.headBottom, `${name}: header overlaps the title`).toBeLessThanOrEqual(value.titleTop)
    expect(value.frame, `${name}: frame ${value.frame} of pane ${value.pane}`).toBeGreaterThan(value.pane * 0.7)
  }
  // The frame scrolls the tall artifact, by keyboard as well.
  await frame.locator("p").first().click()
  await page.keyboard.press("PageDown")
  const artifact = page.frames().find((item) => item.url().includes("/__es/frame/srf_spec"))
  // Keyboard scrolling may animate: wait for it to move.
  await expect.poll(() => artifact.evaluate(() => scrollY)).toBeGreaterThan(0)
  const scrolled = await artifact.evaluate(() => ({ y: scrollY, height: document.documentElement.scrollHeight, view: innerHeight }))
  results.frameScroll = scrolled
  expect(scrolled.height).toBeGreaterThan(scrolled.view)
  expect(await detail.evaluate((section) => section.scrollTop)).toBe(0)
  // Narrow (one column): the frame keeps a usable height, as this host's own Surface reader does.
  await page.setViewportSize({ width: 800, height: 900 })
  await page.waitForTimeout(200)
  results.narrow = await detail.evaluate((section) => Math.round(section.querySelector("iframe.desk-surface-frame").getBoundingClientRect().height))
  expect(results.narrow).toBeGreaterThanOrEqual(Math.round(900 * 0.7) - 2)
  expect(errors).toEqual([])
  console.log(JSON.stringify(results))
  console.log("PASS work remote surface: frame fills the pane at 1280x900, 1600x1000 and after resizing to 1100x700; pane does not scroll; header above title; frame scrolls by keyboard; narrow keeps 70vh")
} finally {
  await browser.close()
  await preview.close()
}
