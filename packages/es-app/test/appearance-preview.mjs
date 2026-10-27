// Private preview of the wallpaper appearance: the composer panel fixture plus a fake
// /__es/appearance route serving a palette and a pre-blurred image (the same contract the
// desktop bridge implements). APPEARANCE_PALETTE / APPEARANCE_WALLPAPER override the inputs;
// POST-free: touching the palette file emits a change event.
import { readFileSync, watch } from "node:fs"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const palettePath = process.env.APPEARANCE_PALETTE ?? path.join(os.homedir(), ".cache/wal/colors.json")
const blurred = path.join(os.tmpdir(), `es-appearance-${process.pid}.jpg`)
const streams = new Set()
const state = { body: undefined }
const reload = () => {
  try {
    const raw = JSON.parse(readFileSync(palettePath, "utf8"))
    const wallpaper = process.env.APPEARANCE_WALLPAPER ?? raw.wallpaper
    if (wallpaper) execFileSync("magick", [wallpaper, "-resize", "640x", "-blur", "0x18", "-quality", "70", blurred])
    state.body = { palette: { ...raw.special, ...raw.colors }, wallpaper: wallpaper ? `/__es/appearance/wallpaper?v=${Date.now()}` : undefined, updatedAt: Date.now() }
    for (const res of streams) res.write("data: changed\n\n")
  } catch {
    // Partial writes keep the last good state.
  }
}
reload()
watch(path.dirname(palettePath), () => { clearTimeout(reload.t); reload.t = setTimeout(reload, 300) })
const plugin = {
  name: "appearance-fixture",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url, "http://x")
      if (url.pathname === "/__es/appearance") {
        if (!state.body) { res.statusCode = 404; return res.end() }
        res.setHeader("content-type", "application/json")
        return res.end(JSON.stringify(state.body))
      }
      if (url.pathname === "/__es/appearance/wallpaper") {
        res.setHeader("content-type", "image/jpeg"); res.setHeader("cache-control", "max-age=31536000, immutable")
        return res.end(readFileSync(blurred))
      }
      if (url.pathname === "/__es/appearance/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        streams.add(res); req.on("close", () => streams.delete(res)); return
      }
      next()
    })
  },
}

export const startAppearancePreview = (port = 0) => startPanelPreview([plugin], port)

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startAppearancePreview(Number(process.env.PORT ?? 0))
  console.log(`PREVIEW ${preview.url}\nSTOP kill ${process.pid}`)
  process.on("SIGTERM", async () => { await preview.close(); process.exit(0) })
}
