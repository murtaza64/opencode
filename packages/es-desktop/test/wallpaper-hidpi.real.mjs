// Wallpaper resolution on this display (wallpaper hotfix after BUG-16): a private profile and pywal directory with a
// 5120x2880 fixture wallpaper (diagonal fine stripes over a gradient; never the user's image or settings). For no Studio
// look and Studio blur 0, 2, 16 and 64 it reads the served wallpaper's pixel size, bytes, smoothness and how long the
// reblur took, against the window's device-pixel width (how far the page stretches the image), and saves a screenshot.
// Run from packages/es-desktop: node test/wallpaper-hidpi.real.mjs [<packaged Editspace executable>] [<label>]
import { _electron } from "@playwright/test"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"
import { createFixture, directory } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const executable = process.argv[2] && process.argv[2] !== "-" ? process.argv[2] : process.env.ES_DESKTOP_EXECUTABLE
const label = process.argv[3] ?? (executable ? "packaged" : "dev")
const out = process.env.ES_PROOF_OUT ?? tmpdir()
const profile = await mkdtemp(path.join(tmpdir(), "es-wallpaper-hidpi-profile-"))
const wal = await mkdtemp(path.join(tmpdir(), "es-wallpaper-hidpi-wal-"))
const WIDTH = 5120
const HEIGHT = 2880
const wallpaper = path.join(wal, "fixture-wallpaper.png")
await writeFile(wallpaper, stripes(WIDTH, HEIGHT))
const writeLook = async (studio) => {
  const colors = { wallpaper, special: { background: "#101014", foreground: "#e0e0e0", cursor: "#ffffff" }, colors: { color0: "#101014", color1: "#ff5555", color2: "#50fa7b", color4: "#4a9eff" }, ...(studio ? { studio } : {}) }
  await writeFile(path.join(wal, "colors.json.tmp"), JSON.stringify(colors))
  await rename(path.join(wal, "colors.json.tmp"), path.join(wal, "colors.json"))
}
await writeLook(undefined)
const fixture = await createFixture()
const electron = await _electron.launch({
  ...(executable ? { executablePath: executable, args: [] } : { args: [root] }),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "",
    ES_DESKTOP_USER_DATA: profile, ES_APPEARANCE_DIR: wal },
})
const results = []
try {
  const page = await electron.firstWindow()
  await page.waitForURL("http://127.0.0.1:*/")
  const origin = new URL(page.url()).origin
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await page.locator(".session-page").waitFor()
  const served = () => page.evaluate(async () => (await (await fetch("/__es/appearance", { cache: "no-store" })).json()).wallpaper)
  const observe = async (name, studio, previous) => {
    const started = Date.now()
    if (studio !== "initial") await writeLook(studio)
    let version
    for (let wait = 50; !(version = await served()) || version === previous; wait = Math.min(wait * 2, 1000)) {
      if (Date.now() - started > 60_000) throw new Error(`${name}: wallpaper never changed`)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
    const ms = Date.now() - started
    const shown = await page.evaluate(async (src) => {
      const bytes = (await (await fetch(src)).arrayBuffer()).byteLength
      const image = new Image()
      image.src = src
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext("2d")
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let total = 0
      for (let y = 0; y < canvas.height; y++)
        for (let x = 1; x < canvas.width; x++) total += Math.abs(pixels[(y * canvas.width + x) * 4] - pixels[(y * canvas.width + x - 1) * 4])
      const box = document.querySelector(".session-page").getBoundingClientRect()
      return { imageWidth: image.naturalWidth, imageHeight: image.naturalHeight, bytes, roughness: Math.round((total / (canvas.height * (canvas.width - 1))) * 100) / 100,
        devicePixelRatio, pageDeviceWidth: Math.round(box.width * devicePixelRatio) }
    }, version)
    const display = await electron.evaluate(({ screen }) => Math.max(...screen.getAllDisplays().map((item) => item.size.width * item.scaleFactor)))
    await page.screenshot({ path: path.join(out, `wallpaper-${label}-${name.replace(/\W+/g, "_")}.png`), scale: "device" })
    const row = { label, look: name, ms, displayDeviceWidth: display, ...shown, stretch: Math.round((Math.max(shown.pageDeviceWidth, 1) / shown.imageWidth) * 100) / 100 }
    results.push(row)
    return version
  }
  let version = await observe("no look", "initial", undefined)
  for (const blur of [0, 2, 16, 64]) version = await observe(`blur ${blur}`, { blur, tint: 0.95, dim: 0.2 }, version)
  console.log(JSON.stringify(results, null, 2))
} finally {
  await electron.close()
  await fixture.close?.()
  await rm(profile, { recursive: true, force: true })
  await rm(wal, { recursive: true, force: true })
}

// Greyscale PNG: a left-to-right gradient under 2px diagonal stripes, so both detail loss and blockiness show.
function stripes(width, height) {
  const rows = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    rows[y * (width + 1)] = 0
    for (let x = 0; x < width; x++) rows[y * (width + 1) + 1 + x] = Math.round(40 + (150 * x) / width + (((x + y) >> 1) % 2 ? 50 : 0))
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
