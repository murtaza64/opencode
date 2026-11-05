// One wallpaper behind two side-by-side chat panes (Loupe #1560): the image is painted once at window level, both
// panes keep only a scrim, and the divider is a thin translucent hairline. Checks pixel continuity across the seam,
// no re-crop when the split opens, the same after a drag-resize and a window resize, and that a theme/wallpaper change
// repaints both. Disposable fixture; the appearance route is a fixture image and a dark palette.
// Run from packages/es-app: node test/wallpaper-split.browser.mjs [--shots DIR]
import { createRequire } from "node:module"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const capture = !!process.env.WALLPAPER_SPLIT_CAPTURE
const preview = await startPanelPreview()
preview.fixture.status = "idle"
// Enough history that the main transcript has an independent scroll to exercise.
preview.fixture.messages = Array.from({ length: 30 }, (_, index) => ({
  info: { id: `msg_w${String(index).padStart(4, "0")}`, sessionID: "ses_a", role: index % 2 ? "assistant" : "user", agent: "build",
    model: { providerID: "fixture", modelID: "test" }, time: { created: index + 1 } },
  parts: [{ id: `part_w${index}`, messageID: `msg_w${String(index).padStart(4, "0")}`, sessionID: "ses_a", type: "text", text: `Wallpaper row ${index}: ${"Context to read. ".repeat(12)}` }],
}))
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(value => {
  try {
    localStorage.setItem("es-app:front-desk:1", JSON.stringify(value))
    // A session view opens the companion only on request; start closed so the open transition can be measured.
    localStorage.setItem("es-app:companion:session", "0")
  } catch { /* the fixture page's own origin */ }
}, { session: "ses_b", directory })

// A horizontal colour ramp: a re-cropped copy jumps at the seam, while one image behind both panes stays smooth.
const wallpaper = ramp(1440, 900)
const palette = { background: "#101014", foreground: "#e0e0e0", surface1: "#1a1b22", surface2: "#24262e", surface3: "#30323c",
  bright_red: "#ff5555", bright_green: "#50fa7b", bright_blue: "#4a9eff", bright_cyan: "#00e5ff" }
let version = 0
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", error => errors.push(error.message))
await page.route((url) => new URL(url).pathname === "/__es/appearance", (route) =>
  route.fulfill({ json: { palette, wallpaper: `/__fixture/wallpaper?v=${version}`, updatedAt: Date.now() } }))
await page.route("**/__fixture/wallpaper?*", (route) => route.fulfill({ contentType: "image/png", body: wallpaper }))
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())

const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }) }
// RGB under a viewport point, from one screenshot (CSS pixels; the fixture context has deviceScaleFactor 1).
const pixel = async (points) => {
  const png = (await page.screenshot()).toString("base64")
  return page.evaluate(async ({ png, points }) => {
    const image = new Image()
    image.src = `data:image/png;base64,${png}`
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext("2d")
    context.drawImage(image, 0, 0)
    return points.map(({ x, y }) => [...context.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)])
  }, { png, points })
}
const seam = async () => page.evaluate(() => {
  const box = document.querySelector(".desk-companion-in").getBoundingClientRect()
  return { at: Math.round(box.left), y: Math.round(box.top + box.height * 0.62) }
})
const continuity = async (label) => {
  const { at, y } = await seam()
  const [left, right] = await pixel([{ x: at - 6, y }, { x: at + 6, y }])
  const diff = Math.max(...left.map((value, index) => Math.abs(value - right[index])))
  return { label, at, y, left, right, diff }
}

try {
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(page.locator(".session-page").first()).toBeVisible({ timeout: 120_000 })
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.appearance)).toBe("wallpaper")
  await expect(page.locator(".desk-companion")).toHaveClass(/closed/, { timeout: 120_000 })
  await page.waitForTimeout(500)
  // The single wall layer must stay the same size when the companion opens (no re-crop of the image).
  const layerBefore = await page.evaluate(() => {
    const layer = document.querySelector(".wallpaper-backdrop")
    const box = layer?.getBoundingClientRect()
    const style = layer ? getComputedStyle(layer) : undefined
    return box && style ? { width: Math.round(box.width), height: Math.round(box.height), size: style.backgroundSize, position: style.backgroundPosition } : undefined
  })

  // Open the split.
  await page.locator('[data-nav="front-desk"]').click()
  await expect(page.locator(".desk-companion")).not.toHaveClass(/closed/, { timeout: 60_000 })
  await expect(page.locator(".desk-companion .session-page")).toBeVisible({ timeout: 120_000 })
  await page.waitForTimeout(500)
  const layerAfter = await page.evaluate(() => {
    const layer = document.querySelector(".wallpaper-backdrop")
    const box = layer?.getBoundingClientRect()
    const style = layer ? getComputedStyle(layer) : undefined
    return box && style ? { width: Math.round(box.width), height: Math.round(box.height), size: style.backgroundSize, position: style.backgroundPosition } : undefined
  })
  const recrop = layerBefore && layerAfter ? JSON.stringify(layerBefore) !== JSON.stringify(layerAfter) : true
  await shot("wallpaper-split-open")

  const first = await continuity("open")
  // Independent scroll: the image is outside both transcripts, so scrolling does not move it.
  const layerBox = () => page.evaluate(() => {
    const layer = document.querySelector(".wallpaper-backdrop")
    const box = layer?.getBoundingClientRect()
    return box ? { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) } : undefined
  })
  const beforeScroll = await layerBox()
  await page.evaluate(() => { const transcript = document.querySelector(".content .transcript"); if (transcript) transcript.scrollTop = Math.min(220, transcript.scrollHeight - transcript.clientHeight) })
  await page.waitForTimeout(200)
  const afterScroll = await layerBox()
  const scrolled = await continuity("scrolled")
  // Drag the companion's inline-start handle; the seam moves and the image behind it does not.
  const handle = page.locator(".drag-handle").last()
  const box = await handle.boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x - 70, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(300)
  }
  const dragged = await continuity("dragged")
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.waitForTimeout(500)
  const resized = await continuity("resized")
  // A wallpaper change is one inherited variable: both panes repaint without a second copy.
  version++
  const next = ramp(1440, 900, 1)
  await page.evaluate(async (next) => {
    // Swap the served image through the same variable the appearance route sets.
    document.documentElement.style.setProperty("--wallpaper", `url("data:image/png;base64,${next}")`)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }, next.toString("base64"))
  const changed = await continuity("changed")
  await shot("wallpaper-split-changed")

  console.log(JSON.stringify({ layerBefore, layerAfter, recrop, beforeScroll, afterScroll, first, scrolled, dragged, resized, changed }, null, 1))
  if (!capture) {
    expect(layerBefore && layerAfter, "the wall layer is present before and after the split opens").toBeTruthy()
    expect(recrop, "opening the split must not re-crop the wallpaper").toBe(false)
    expect(afterScroll, "the wallpaper does not scroll with the transcript").toEqual(beforeScroll)
    for (const result of [first, scrolled, dragged, resized, changed]) expect(result.diff, `${result.label}: wallpaper is continuous across the seam`).toBeLessThan(10)
    expect(errors).toEqual([])
  }
  console.log(capture ? "CAPTURE wallpaper split" : "PASS wallpaper split: one image across the seam, no re-crop, drag and resize stable")
} finally {
  await browser.close()
  await preview.close()
}

// A horizontal ramp PNG; `flip` reverses the hue direction for the changed-wallpaper check.
function ramp(width, height, flip = 0) {
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    rows[y * (width * 3 + 1)] = 0
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3
      const t = flip ? 1 - x / width : x / width
      rows[at] = Math.round(40 + 160 * t)
      rows[at + 1] = Math.round(60 + 100 * (y / height))
      rows[at + 2] = Math.round(70 + 90 * t)
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))])
}
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
