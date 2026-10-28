// Session view feel (dotfiles#240): the wallpaper backdrop reaches the session's own edges (the nav on one
// side, the info panel or window edge on the other) with no solid gutters, and genuine work moves: while
// the agent works, its activity indicator animates on the compositor; idle and reduced motion stay still.
// Disposable in-memory fixture; the wallpaper is a generated SVG. Run from packages/es-app:
//   node test/session-backdrop-motion.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { startToolRunsPreview } from "./tool-runs-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const WALLPAPER = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><defs><linearGradient id="g"><stop offset="0" stop-color="#ff2d95"/><stop offset="1" stop-color="#4a9eff"/></linearGradient></defs><rect width="640" height="400" fill="url(#g)"/></svg>`
const palette = { background: "#10121a", foreground: "#e0e4f0", color0: "#10121a", color1: "#e0605a", color2: "#5ac8a0", color3: "#e0c060", color4: "#6090e0", color5: "#b070e0", color6: "#50c0e0", color7: "#c0c4d0", color8: "#505868", color9: "#f07068", color10: "#68d8b0", color11: "#f0d070", color12: "#70a0f0", color13: "#c080f0", color14: "#60d0f0", color15: "#e0e4f0" }
const appearance = {
  name: "appearance-fixture",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url, "http://x")
      if (url.pathname === "/__es/appearance") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ palette, wallpaper: "/__es/appearance/wallpaper", updatedAt: 1 })) }
      if (url.pathname === "/__es/appearance/wallpaper") { res.setHeader("content-type", "image/svg+xml"); return res.end(WALLPAPER) }
      if (url.pathname === "/__es/appearance/events") { res.writeHead(200, { "content-type": "text/event-stream" }); return }
      next()
    })
  },
}
const preview = await startPanelPreview([appearance])
// A turn with a running bash call, for the running-tool indicator.
const tools = await startToolRunsPreview(0, { filler: 5 })
const browser = await chromium.launch({ channel: "chrome", headless: true })

const open = async ({ width, height, rtl = false, reducedMotion = "no-preference", status = "busy", target = preview, thinking = false }) => {
  target.fixture.status = status
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion })
  await context.route("**/*", route => new URL(route.request().url()).origin === target.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  if (target === preview) await expect(page.locator(":root[data-appearance=wallpaper]")).toHaveCount(1)
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible()
  // A just-sent prompt with no reply yet: the transcript tail shows the thinking dot.
  if (thinking) {
    target.fixture.emit("message.updated", { info: { id: "msg_zz_wait", sessionID: "ses_a", role: "user", time: { created: Date.now() }, agent: "build", model: { providerID: "fixture", modelID: "fixture" } } })
    await expect(page.locator(".transcript .thinking")).toBeVisible()
  }
  if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await page.waitForTimeout(300)
  return { page, errors, close: () => context.close() }
}

// Where the wallpaper paints, against the session's own edges: from the nav (or window edge) to the info
// panel (or window edge). The backdrop is whichever element's ::before carries the wallpaper image.
const backdrop = page => page.evaluate(() => {
  const box = el => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) } }
  const painter = [...document.querySelectorAll(".content, .content *")].find(el => getComputedStyle(el, "::before").backgroundImage.includes("url("))
  const content = box(document.querySelector(".content"))
  const panel = document.querySelector(".session-page > .session-info, .session-page > aside, .session-page > :last-child:not(.session-main)")
  const panelBox = panel && panel.getBoundingClientRect().width > 0 ? box(panel) : undefined
  const ltr = getComputedStyle(document.documentElement).direction !== "rtl"
  // The session region: the content column minus a visible info panel beside it (stacked below on a phone).
  const beside = panelBox && panelBox.top <= content.top + 1
  const region = !beside ? content : ltr ? { ...content, right: panelBox.left } : { ...content, left: panelBox.right }
  // An opaque band inside the backdrop (the title bar) must not stop short of the region's edges either.
  const bar = document.querySelector(".session-page .topbar")
  const barBand = bar && !/rgba\([^)]*,\s*0\)|transparent/.test(getComputedStyle(bar).backgroundColor) ? box(bar) : undefined
  const panelOpaque = panel ? /^rgb\(|rgba\([^)]*,\s*1\)$/.test(getComputedStyle(panel).backgroundColor) : undefined
  return { region, barBand, panelOpaque, painted: painter ? box(painter) : undefined, painter: painter ? `${painter.tagName.toLowerCase()}.${[...painter.classList].join(".")}` : undefined, panel: panelBox }
})
// Running, endless animations and the properties they animate.
const motion = page => page.evaluate(() => document.getAnimations()
  .filter(animation => animation.playState === "running" && animation.effect?.getTiming().iterations === Infinity)
  .map(animation => {
    const target = animation.effect.target
    const visible = target && target.getBoundingClientRect().width > 0
    const properties = [...new Set(animation.effect.getKeyframes().flatMap(frame => Object.keys(frame).filter(key => !["offset", "easing", "composite", "computedOffset"].includes(key))))]
    return { name: animation.animationName, inTranscript: !!target?.closest(".transcript"), target: target ? `${target.tagName.toLowerCase()}.${[...target.classList].join(".")}${animation.effect.pseudoElement ?? ""}` : "", visible, properties }
  }))

let failed = false
const check = async (name, options, verify) => {
  const view = await open(options)
  try {
    const result = { backdrop: await backdrop(view.page), motion: await motion(view.page) }
    console.log(`${name} ${JSON.stringify(result)}`)
    if (shots) await view.page.screenshot({ path: path.join(shots, `${name}.png`) })
    verify(result)
    assert.deepEqual(view.errors, [])
    console.log(`PASS ${name}`)
  } catch (error) {
    failed = true
    console.error(`FAIL ${name}: ${error.message}`)
  } finally {
    await view.close()
  }
}
const reachesEdges = (name, { backdrop }) => {
  assert(backdrop.painted, `${name}: a wallpaper backdrop is painted`)
  assert(backdrop.painted.left <= backdrop.region.left + 1 && backdrop.painted.right >= backdrop.region.right - 1,
    `${name}: wallpaper spans the session region with no gutters ${JSON.stringify(backdrop)}`)
  assert(!backdrop.barBand || (backdrop.barBand.left <= backdrop.region.left + 1 && backdrop.barBand.right >= backdrop.region.right - 1),
    `${name}: no opaque title band narrower than the session region ${JSON.stringify(backdrop)}`)
  assert(backdrop.panelOpaque !== false, `${name}: the info panel stays opaque over the backdrop ${JSON.stringify(backdrop)}`)
  assert(backdrop.painted.top <= backdrop.region.top + 1 && backdrop.painted.bottom >= backdrop.region.bottom - 1, `${name}: wallpaper spans the full height ${JSON.stringify(backdrop)}`)
}
const compositorOnly = ({ motion }) => motion.forEach(item => assert(item.properties.every(property => ["opacity", "transform"].includes(property)), `animates only opacity/transform ${JSON.stringify(item)}`))

try {
  await check("working-1440x900", { width: 1440, height: 900, thinking: true }, result => {
    reachesEdges("working-1440x900", result)
    // The working agent shows motion in the transcript, where the reader is looking, not only in a status line.
    assert(result.motion.some(item => item.visible && item.target.includes("busy-dot") && item.inTranscript), `working: the transcript's thinking dot animates ${JSON.stringify(result.motion)}`)
    compositorOnly(result)
  })
  await check("running-tool-1440x900", { width: 1440, height: 900, target: tools }, result => {
    assert(result.motion.some(item => item.visible && item.inTranscript && /spinner|tool-size-bar/.test(item.target)), `running tool: its indicator animates ${JSON.stringify(result.motion)}`)
    compositorOnly(result)
  })
  await check("idle-1440x900", { width: 1440, height: 900, status: "idle" }, result => {
    reachesEdges("idle-1440x900", result)
    assert.deepEqual(result.motion, [], "idle: nothing animates")
  })
  await check("reduced-motion-1440x900", { width: 1440, height: 900, reducedMotion: "reduce" }, result => assert.deepEqual(result.motion, [], "reduced motion: nothing animates"))
  await check("rtl-1280x800", { width: 1280, height: 800, rtl: true }, result => reachesEdges("rtl-1280x800", result))
  await check("zoom125-1152x720", { width: 1152, height: 720 }, result => reachesEdges("zoom125-1152x720", result))
  await check("narrow-600x800", { width: 600, height: 800 }, result => reachesEdges("narrow-600x800", result))
} finally {
  await browser.close()
  await preview.close()
  await tools.close()
}
if (failed) process.exit(1)
console.log("session-backdrop-motion: PASS")
