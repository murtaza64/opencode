// A Surface is seamless in the centre pane (Laptop2547/2578/2659), this host's and another Work host's. In the Mac app
// (NATIVE=1, the default: an Electron/Mac user agent, so the app top bar is the window's title bar) its title and
// actions sit in that one top bar and the frame touches all four pane edges; in a plain browser (NATIVE=0) the same row
// is the pane's inline header and the frame touches left, right and bottom. At wide, split (chat docked) and narrow
// windows and after a resize; the pane does not scroll; the frame owns scrolling of a tall artifact, by keyboard too;
// Escape closes it from the pane or the top bar; with chat docked, the top bar closes the Surface, not the chat. Disposable fixture. Run from packages/es-app: node test/work-remote-surface.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const native = process.env.NATIVE !== "0"
const page = await browser.newPage({ viewport: { width: 1280, height: 900 },
  ...(native ? { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Electron/42.3.3 Chrome/142.0.0.0 Safari/537.36" } : {}) })
page.setDefaultTimeout(60_000)
// The docked chat is the Front desk on an existing fixture session, so it has a composer to hold a draft.
await page.addInitScript((value) => { if (window === window.top) localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) }, { session: "ses_a", directory })
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
// The centre pane is the desk grid; the frame sits on its edges, below the top bar (native) or the inline header.
const measure = (selector) => page.locator(selector).evaluate((section) => {
  const box = (element) => element.getBoundingClientRect()
  const pane = box(section.closest(".desk-grid"))
  const frame = box(section.querySelector("iframe.desk-surface-frame"))
  const head = document.querySelector(".surface-head")
  return { top: Math.round(frame.top - pane.top), left: Math.round(frame.left - pane.left), right: Math.round(pane.right - frame.right), bottom: Math.round(pane.bottom - frame.bottom),
    headInTopBar: !!head?.closest(".native-header"), headHeight: head ? Math.round(box(head).height) : null, oldBar: document.querySelectorAll(".surface-bar").length,
    heads: section.querySelectorAll(".desk-evidence-head").length, frame: Math.round(frame.height), paneScrolls: section.scrollHeight > section.clientHeight + 1 }
})
const seamless = (name, value) => {
  for (const edge of native ? ["top", "left", "right", "bottom"] : ["left", "right", "bottom"]) expect(Math.abs(value[edge]), `${name}: frame ${edge} inset ${value[edge]}px`).toBeLessThanOrEqual(1)
  expect(value.headInTopBar, `${name}: title and actions in the app top bar`).toBe(native)
  expect(value.headHeight, `${name}: head height`).toBeLessThanOrEqual(native ? 44 : 48)
  expect(value.oldBar, `${name}: second Surface bar`).toBe(0)
  expect(value.heads, `${name}: stacked header`).toBe(0)
  expect(value.paneScrolls, `${name}: the pane scrolls`).toBe(false)
}
const head = () => page.locator(".surface-head")
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
  // Escape from the top bar's own button (outside the section when native) closes it.
  await head().getByRole("button", { name: "Close and return to chat" }).focus()
  await page.keyboard.press("Escape")
  await expect(localPane).toHaveCount(0)
  await expect(head()).toHaveCount(0)
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
  // Chat docked beside the Surface: the top bar's close targets the Surface; the chat and its draft stay.
  await page.setViewportSize({ width: 1440, height: 900 })
  const openChat = page.locator(".desk-companion:not(.closed)")
  await page.waitForTimeout(300)
  if (!(await openChat.count())) await chat.click()
  await expect(openChat).toHaveCount(1)
  // A draft typed in the chat survives closing the Surface with the top-bar Close and with Escape.
  const draft = page.locator(".desk-chat textarea").first()
  await expect(draft).toBeVisible()
  await draft.fill("chat draft kept")
  await expect(head().getByRole("button", { name: "Close" })).toBeVisible()
  await expect(head()).toContainText("Mac Mini")
  await head().getByRole("button", { name: "Close" }).click()
  await expect(detail).toHaveCount(0)
  await expect(openChat).toHaveCount(1)
  await expect(draft).toHaveValue("chat draft kept")
  await row.click()
  await expect(detail.locator("iframe.desk-surface-frame")).toBeVisible()
  await head().getByRole("button", { name: "Close" }).focus()
  await page.keyboard.press("Escape")
  await expect(detail).toHaveCount(0)
  await expect(openChat).toHaveCount(1)
  await expect(draft).toHaveValue("chat draft kept")
  results.splitClose = { chatOpen: true, draftKept: await draft.inputValue() }
  await chat.click()
  await expect(openChat).toHaveCount(0)
  await row.click()
  await expect(detail.locator("iframe.desk-surface-frame")).toBeVisible()
  await expect(frame.locator("nav")).toHaveText("Spec nav")
  // The frame scrolls the tall artifact, by keyboard as well (the reopened frame: the last one with that address).
  await frame.locator("p").first().click()
  const artifact = page.frames().filter((item) => item.url().includes("/__es/frame/srf_spec") && !item.isDetached()).at(-1)
  // Keys go to the frame only once its document holds focus: wait for that observable state, not a sleep, so the
  // press cannot race the click's focus hand-off (it did on a loaded host, DD #451). One press, never retried.
  await expect.poll(() => artifact.evaluate(() => document.readyState === "complete" && document.hasFocus())).toBe(true)
  await page.keyboard.press("PageDown")
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
  expect(results.narrow.oldBar).toBe(0)
  expect(results.narrow.frame).toBeGreaterThanOrEqual(Math.round(900 * 0.7) - 2)
  // Escape closes another host's Surface too.
  await head().getByRole("button", { name: "Close" }).focus()
  await page.keyboard.press("Escape")
  await expect(detail).toHaveCount(0)
  expect(errors).toEqual([])
  console.log(JSON.stringify(results))
  console.log(`PASS seamless surface (${native ? "native top bar" : "browser inline header"}): local and remote title/actions in ${native ? "the app top bar, frame 0px on all four edges" : "the inline header, frame 0px left/right/bottom"}; no second bar; wide/split/resized/narrow; frame scrolls by keyboard; Escape closes from the top bar; with chat docked, top-bar Close and Escape close the Surface and keep the chat and its draft`)
} finally {
  await browser.close()
  await preview.close()
}
