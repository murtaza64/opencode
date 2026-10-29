// WalStudio's look in the app (BUG-16): a private profile and a private pywal directory (fixture colors.json and a
// fixture wallpaper; the live wallpaper and Studio Apply are never touched). For two blur settings and a dim-only
// change it reads the app's appearance receipt (the look it serves), the served wallpaper's version and how smooth
// it is, and the page's computed --wallpaper-dim and backdrop layer.
// Run from packages/es-desktop: node test/studio-look.real.mjs [<packaged Editspace executable>]
// (or ES_DESKTOP_EXECUTABLE=<bin>; without either, the dev build in this package).
import { _electron, expect } from "@playwright/test"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"
import { createFixture, directory } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const executable = process.argv[2] ?? process.env.ES_DESKTOP_EXECUTABLE
const profile = await mkdtemp(path.join(tmpdir(), "es-studio-look-profile-"))
const wal = await mkdtemp(path.join(tmpdir(), "es-studio-look-wal-"))
const WIDTH = 1280
const HEIGHT = 720
const wallpaper = path.join(wal, "fixture-wallpaper.png")
await writeFile(wallpaper, checkerboard(WIDTH, HEIGHT, 8))
// Studio's colors.json as Apply writes it (palette + wallpaper + studio look), replaced atomically like pywal.
const writeLook = async (studio) => {
  const colors = { wallpaper, special: { background: "#101014", foreground: "#e0e0e0", cursor: "#ffffff" }, colors: { color0: "#101014", color1: "#ff5555", color2: "#50fa7b", color4: "#4a9eff" }, studio }
  await writeFile(path.join(wal, "colors.json.tmp"), JSON.stringify(colors))
  await rename(path.join(wal, "colors.json.tmp"), path.join(wal, "colors.json"))
}
await writeLook({ blur: 4, tint: 0.95, dim: 0.2 })
const fixture = await createFixture()
const electron = await _electron.launch({
  ...(executable ? { executablePath: executable, args: [] } : { args: [root] }),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "",
    ES_DESKTOP_USER_DATA: profile, ES_APPEARANCE_DIR: wal, ES_DESKTOP_START: "hidden" },
})
const results = []
try {
  const page = await electron.firstWindow()
  await page.waitForURL("http://127.0.0.1:*/")
  const origin = new URL(page.url()).origin
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await page.locator(".session-page").waitFor()
  const receipt = async () => JSON.parse(await readFile(path.join(profile, "appearance-receipt.json"), "utf8").catch(() => "{}"))
  // Waits (doubling) until the receipt serves `look`, then reads what the app serves and what the page shows.
  const observe = async (label, look) => {
    const deadline = Date.now() + 60_000
    for (let wait = 100; JSON.stringify((await receipt()).look) !== JSON.stringify(look); wait = Math.min(wait * 2, 2000)) {
      if (Date.now() > deadline) throw new Error(`${label}: receipt never showed ${JSON.stringify(look)}`)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
    await page.waitForFunction((dim) => (getComputedStyle(document.documentElement).getPropertyValue("--wallpaper-dim").trim() || "0") === String(dim), look.dim)
    const shown = await page.evaluate(async () => {
      const served = await (await fetch("/__es/appearance", { cache: "no-store" })).json()
      const image = new Image()
      image.src = served.wallpaper
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext("2d")
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      // Mean absolute luminance step between horizontal neighbours: lower = smoother (more blurred).
      let total = 0
      for (let y = 0; y < canvas.height; y++)
        for (let x = 1; x < canvas.width; x++) total += Math.abs(pixels[(y * canvas.width + x) * 4] - pixels[(y * canvas.width + x - 1) * 4])
      return {
        version: served.wallpaper,
        imageWidth: image.naturalWidth,
        roughness: Math.round((total / (canvas.height * (canvas.width - 1))) * 100) / 100,
        dimVar: getComputedStyle(document.documentElement).getPropertyValue("--wallpaper-dim").trim(),
        layer: getComputedStyle(document.querySelector(".session-page"), "::before").backgroundImage,
        appearance: document.documentElement.dataset.appearance,
      }
    })
    const served = await receipt()
    // main.ts: a Studio sigma keeps about width / (2 sigma) samples before scaling back to 640.
    const downscale = Math.max(8, Math.min(640, Math.round(WIDTH / (2 * look.blur))))
    const row = { label, receiptLook: served.look, expectedDownscaleWidth: downscale, ...shown }
    results.push(row)
    return row
  }
  const sharp = await observe("blur 4, dim 0.2", { blur: 4, dim: 0.2 })
  await writeLook({ blur: 32, tint: 0.95, dim: 0.2 })
  const soft = await observe("blur 32, dim 0.2", { blur: 32, dim: 0.2 })
  await writeLook({ blur: 32, tint: 0.95, dim: 0.6 })
  const dimmed = await observe("blur 32, dim 0.6 (dim only)", { blur: 32, dim: 0.6 })
  console.log(JSON.stringify(results, null, 2))
  expect(sharp.appearance).toBe("wallpaper")
  expect(sharp.dimVar).toBe("0.2")
  expect(sharp.layer).toContain("rgba(0, 0, 0, 0.2)")
  // A new blur is a new image, visibly smoother.
  expect(soft.version).not.toBe(sharp.version)
  expect(soft.roughness).toBeLessThan(sharp.roughness)
  // Dim alone keeps the same image and changes only the page's layer.
  expect(dimmed.version).toBe(soft.version)
  expect(dimmed.roughness).toBe(soft.roughness)
  expect(dimmed.dimVar).toBe("0.6")
  expect(dimmed.layer).toContain("rgba(0, 0, 0, 0.6)")
  console.log(`PASS studio look: receipt look per setting; blur 4 -> 32 new image (roughness ${sharp.roughness} -> ${soft.roughness}); dim-only same image ${dimmed.version}, --wallpaper-dim 0.2 -> 0.6`)
} finally {
  await electron.close()
  await fixture.close?.()
  await rm(profile, { recursive: true, force: true })
  await rm(wal, { recursive: true, force: true })
}

// A greyscale checkerboard PNG (square size `cell`), written without an image library.
function checkerboard(width, height, cell) {
  const rows = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    rows[y * (width + 1)] = 0
    for (let x = 0; x < width; x++) rows[y * (width + 1) + 1 + x] = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 230 : 25
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
  header.set([8, 0, 0, 0, 0], 8)
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
