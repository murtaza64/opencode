// Chip tone (dotfiles#240): mail chips, coalesced tool runs and your own messages sit darker than the raised
// surface level (fields, hover), still a visible step above the page, with readable text; geometry is
// unchanged. Checked in the default theme and the wallpaper palette, wide and narrow RTL.
// Disposable fixture. Run from packages/es-app: node test/chip-tone.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startToolRunsPreview } from "./tool-runs-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const palette = { background: "#10121a", foreground: "#e0e4f0", color0: "#10121a", color1: "#e0605a", color2: "#5ac8a0", color3: "#e0c060", color4: "#6090e0", color5: "#b070e0", color6: "#50c0e0", color7: "#c0c4d0", color8: "#505868", color9: "#f07068", color10: "#68d8b0", color11: "#f0d070", color12: "#70a0f0", color13: "#c080f0", color14: "#60d0f0", color15: "#e0e4f0" }
const preview = await startToolRunsPreview(0, { filler: 5 })
const fixture = preview.fixture
// One received mail chip in the transcript (a user turn carrying an editspace-mail source).
fixture.messages.push({ info: { ...fixture.messages[0].info, id: "msg_zz_mail", source: { type: "editspace-mail", id: "mail-1", sender: "relay-board", recipient: "lane-beta", kind: "notice" } },
  parts: [{ id: "part_zz_mail", messageID: "msg_zz_mail", sessionID: "ses_a", type: "text", text: "relay-board: high-level progress" }] })
fixture.mail = (es, recipient) => ({ editspace: es, lane: "", messages: recipient === "ses_a" ? [{ id: "mail-1", ts: new Date(1).toISOString(), created_ms: 1, from: "relay-board", to: "lane-beta", direction: "received", text: "relay-board: high-level progress", deliveries: [] }] : [] })
const browser = await chromium.launch({ channel: "chrome", headless: true })

const luminance = rgb => {
  // Computed colours come back as rgb(0-255) or, for color-mix, color(srgb 0-1).
  const scale = rgb.startsWith("color(") ? 1 : 255
  const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / scale).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }

const check = async (name, { width, height, wallpaper = false, rtl = false }) => {
  const context = await browser.newContext({ viewport: { width, height } })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  if (wallpaper) await context.route("**/__es/appearance", route => route.fulfill({ json: { palette, updatedAt: 1 } }))
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(page.locator(".tool-run").first()).toBeVisible({ timeout: 120_000 })
  await expect(page.locator(".mail-activity-summary").first()).toBeVisible()
  if (wallpaper) await expect(page.locator(":root[data-appearance=wallpaper]")).toHaveCount(1)
  if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
  const tones = await page.evaluate(() => {
    const probe = document.createElement("div")
    document.body.append(probe)
    const color = value => { probe.style.background = value; return getComputedStyle(probe).backgroundColor }
    const fill = el => { const style = getComputedStyle(el); return { bg: style.backgroundColor, fg: style.color, box: (r => [Math.round(r.width), Math.round(r.height)])(el.getBoundingClientRect()) } }
    const first = selector => document.querySelector(selector)
    const result = {
      page: color("var(--mantle)"), raised: color("var(--surface0)"),
      mail: fill(first(".mail-activity-summary")), run: fill(first(".tool-run")),
      user: fill(first('.transcript [data-component="user-message-text"], .transcript [data-slot="user-message-text"]')),
    }
    probe.remove()
    return result
  })
  if (shots) {
    await page.locator(".mail-activity-summary").first().screenshot({ path: path.join(shots, `${name}-mail.png`) })
    await page.locator(".tool-run").first().screenshot({ path: path.join(shots, `${name}-run.png`) })
    await page.screenshot({ path: path.join(shots, `${name}.png`) })
  }
  console.log(`${name} ${JSON.stringify(tones)}`)
  for (const part of ["mail", "run", "user"]) {
    const tone = tones[part]
    assert(luminance(tone.bg) < luminance(tones.raised), `${name}: ${part} is darker than raised surfaces ${JSON.stringify(tones)}`)
    assert(luminance(tone.bg) > luminance(tones.page), `${name}: ${part} still a step above the page ${JSON.stringify(tones)}`)
    assert(contrast(tone.bg, tone.fg) >= 4.5, `${name}: ${part} text contrast ${contrast(tone.bg, tone.fg).toFixed(2)} >= 4.5`)
  }
  await context.close()
  return tones
}

let failed = false
const results = {}
try {
  for (const [name, options] of [["default-1440", { width: 1440, height: 900 }], ["wallpaper-1440", { width: 1440, height: 900, wallpaper: true }],
    ["default-rtl-600", { width: 600, height: 900, rtl: true }], ["wallpaper-rtl-600", { width: 600, height: 900, wallpaper: true, rtl: true }]]) {
    try {
      results[name] = await check(name, options)
      console.log(`PASS ${name}`)
    } catch (error) {
      failed = true
      console.error(`FAIL ${name}: ${error.message}`)
    }
  }
} finally {
  await browser.close()
  await preview.close()
}
if (failed) process.exit(1)
console.log("chip-tone: PASS")
