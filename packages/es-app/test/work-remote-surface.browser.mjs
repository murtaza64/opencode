// A Surface is seamless in the centre pane (Laptop2547/2578), this host's and another Work host's: one compact bar
// (<= 32px) and the frame edge to edge (its left, right and bottom on the pane's edges) at wide, split (chat open) and
// narrow windows and after a resize; the pane does not scroll; the frame owns scrolling of a tall artifact, by
// keyboard too; Escape in the pane closes it. Disposable fixture. Run from packages/es-app: node test/work-remote-surface.browser.mjs
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
// The centre pane is the desk grid; the frame should sit on its left, right and bottom edges under one bar.
const measure = (selector) => page.locator(selector).evaluate((section) => {
  const box = (element) => element.getBoundingClientRect()
  const pane = box(section.closest(".desk-grid"))
  const frame = box(section.querySelector("iframe.desk-surface-frame"))
  const bar = section.querySelector(".surface-bar")
  return { left: Math.round(frame.left - pane.left), right: Math.round(pane.right - frame.right), bottom: Math.round(pane.bottom - frame.bottom),
    bar: bar ? Math.round(box(bar).height) : null, heads: section.querySelectorAll(".desk-evidence-head").length, frame: Math.round(frame.height), paneScrolls: section.scrollHeight > section.clientHeight + 1 }
})
const seamless = (name, value) => {
  for (const edge of ["left", "right", "bottom"]) expect(Math.abs(value[edge]), `${name}: frame ${edge} inset ${value[edge]}px`).toBeLessThanOrEqual(1)
  expect(value.bar, `${name}: bar height`).toBeLessThanOrEqual(32)
  expect(value.heads, `${name}: stacked header`).toBe(0)
  expect(value.paneScrolls, `${name}: the pane scrolls`).toBe(false)
}
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
  results.local = await measure(".desk-evidence.desk-surface")
  console.log("local", JSON.stringify(results.local))
  seamless("local", results.local)
  // Escape in the pane (focus on the bar, outside the frame) closes it.
  await localPane.getByRole("button", { name: "Close and return to chat" }).focus()
  await page.keyboard.press("Escape")
  await expect(localPane).toHaveCount(0)
  const row = page.locator("nav.sidebar [data-nav-item='mini~surface:srf_spec']")
  await expect(row).toBeVisible({ timeout: 120_000 })
  await row.click()
  await expect(detail.locator("iframe.desk-surface-frame")).toBeVisible()
  const frame = page.frameLocator(".work-remote iframe.desk-surface-frame")
  await expect(frame.locator("nav")).toHaveText("Spec nav")
  const chat = page.locator("nav.sidebar [data-nav='front-desk']")
  for (const [name, size, split] of [["wide 1440x900", { width: 1440, height: 900 }, false], ["split 1280x900 chat open", { width: 1280, height: 900 }, true], ["resized 1100x700", { width: 1100, height: 700 }, false]]) {
    await page.setViewportSize(size)
    if (split !== (await chat.getAttribute("aria-pressed") === "true")) await chat.click()
    await page.waitForTimeout(300)
    const value = await measure(".work-remote")
    results[name] = value
    console.log(name, JSON.stringify(value))
    seamless(name, value)
    if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}-${name.split(" ")[0]}.png` })
  }
  if (await chat.getAttribute("aria-pressed") === "true") await chat.click()
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
  // Narrow (one column): still seamless, and the frame keeps a usable height.
  await page.setViewportSize({ width: 800, height: 900 })
  await page.waitForTimeout(300)
  results.narrow = await measure(".work-remote")
  console.log("narrow", JSON.stringify(results.narrow))
  for (const edge of ["left", "right"]) expect(Math.abs(results.narrow[edge]), `narrow: frame ${edge} inset`).toBeLessThanOrEqual(1)
  expect(results.narrow.bar).toBeLessThanOrEqual(32)
  expect(results.narrow.frame).toBeGreaterThanOrEqual(Math.round(900 * 0.7) - 2)
  // Escape closes another host's Surface too.
  await detail.getByRole("button", { name: "Close" }).focus()
  await page.keyboard.press("Escape")
  await expect(detail).toHaveCount(0)
  expect(errors).toEqual([])
  console.log(JSON.stringify(results))
  console.log("PASS seamless surface: local and remote frame 0px inset (left/right/bottom), one bar <= 32px, no stacked header, wide/split/resized/narrow; frame scrolls by keyboard; Escape closes")
} finally {
  await browser.close()
  await preview.close()
}
