// The page tells its desktop what it applied (the wal-palette style revision and the theme), once per
// change: this is the renderer acknowledgement the desktop's appearance receipt records.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage()
const acks = []
const palette = { background: "#101014", foreground: "#e0e0e0", color2: "#59bee7" }
let body = { palette, wal: { revision: "rev1", scheme: "dark", roles: { bg: "#000001", fg: "#c4dee5" }, highlights: [], okRiskCvdSafe: false }, updatedAt: 1 }
await page.route("**/__es/appearance", (route) => route.fulfill({ json: body }))
await page.route("**/__es/appearance/events", (route) => route.fulfill({ status: 404, body: "" }))
await page.route("**/__es/appearance/applied", (route) => {
  acks.push(JSON.parse(route.request().postData()))
  return route.fulfill({ status: 204, body: "" })
})
try {
  await page.goto(preview.url)
  await expect.poll(() => acks.length).toBe(1)
  if (JSON.stringify(acks[0]) !== JSON.stringify({ walRevision: "rev1", theme: "wallpaper" })) throw new Error(`FAIL first ack ${JSON.stringify(acks[0])}`)
  await page.waitForTimeout(1000)
  if (acks.length !== 1) throw new Error(`FAIL duplicate acks ${JSON.stringify(acks)}`)
  // A palette with no artifact roles: the page removes its style and says so.
  body = { palette, updatedAt: 2 }
  await page.reload()
  await expect.poll(() => acks.at(-1)).toEqual({ walRevision: null, theme: "wallpaper" })
  console.log(`PASS appearance acknowledgement: one ack per change (${JSON.stringify(acks)})`)
} finally {
  await browser.close()
  await preview.close()
}
