// Screenshot diff for style refactors: captures fixed scenes (LTR and RTL) into a directory, or compares two
// directories pixel by pixel in the browser. The page clock is pinned so relative times match across runs.
// Run from packages/es-app:
//   node test/visual-diff.mjs --capture /tmp/before   (on the old code)
//   node test/visual-diff.mjs --capture /tmp/after    (on the new code)
//   node test/visual-diff.mjs --compare /tmp/before /tmp/after
import { createRequire } from "node:module"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const index = (name) => process.argv.indexOf(`--${name}`)
const NOW = new Date("2026-11-21T12:00:00Z")

if (index("compare") !== -1) {
  const [a, b] = process.argv.slice(index("compare") + 1)
  const browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  let failed = 0
  for (const file of (await readdir(a)).filter((name) => name.endsWith(".png")).sort()) {
    const [left, right] = await Promise.all([readFile(path.join(a, file)), readFile(path.join(b, file)).catch(() => undefined)])
    if (!right) { console.log(`MISSING ${file}`); failed++; continue }
    const result = await page.evaluate(async ([left, right]) => {
      const load = async (base64) => { const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode(); return image }
      const [x, y] = await Promise.all([load(left), load(right)])
      if (x.width !== y.width || x.height !== y.height) return { size: `${x.width}x${x.height} vs ${y.width}x${y.height}` }
      const pixels = (image) => { const canvas = new OffscreenCanvas(image.width, image.height); const context = canvas.getContext("2d"); context.drawImage(image, 0, 0); return context.getImageData(0, 0, image.width, image.height).data }
      const p = pixels(x), q = pixels(y)
      let diff = 0
      for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2]) diff++
      return { diff, total: p.length / 4 }
    }, [left.toString("base64"), right.toString("base64")])
    if (result.size || result.diff) failed++
    console.log(`${result.size || result.diff ? "DIFF" : "SAME"} ${file} ${JSON.stringify(result)}`)
  }
  await browser.close()
  process.exit(failed ? 1 : 0)
}

const out = process.argv[index("capture") + 1]
await mkdir(out, { recursive: true })
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const message = (id, role, parts) => ({ info: role === "user"
  ? { id, sessionID: "ses_a", role, agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: NOW.getTime() - 60_000 } }
  : { id, sessionID: "ses_a", role, parentID: "msg_v0", agent: "build", mode: "build", providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: NOW.getTime() - 50_000, completed: NOW.getTime() - 40_000 }, finish: "stop" },
  parts: parts.map((part, n) => ({ id: `prt_${id}_${n}`, messageID: id, sessionID: "ses_a", ...part })) })
fixture.messages = [
  message("msg_v0", "user", [{ type: "text", text: "Check the plan and **summarise** it." }]),
  message("msg_v1", "assistant", [
    { type: "reasoning", text: "**Reading the plan**\n\nThe plan has three steps.\n\n**Checking steps**\n\nStep two depends on step one.", time: { start: 1, end: 2 } },
    { type: "tool", callID: "call_v1", tool: "bash", state: { status: "completed", input: { command: "ls", description: "List files" }, output: "a\nb", title: "List files", metadata: {}, time: { start: 1, end: 2 } } },
    { type: "text", text: "Plan:\n\n- [x] First step **done**\n- [ ] Second step\n\n1. Loose item\n\n   with a paragraph\n\nPlain paragraph with **bold** and `code`." },
  ]),
]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const shoot = async (name, url, prepare = async () => {}) => {
  for (const dir of ["ltr", "rtl"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
    await page.clock.install({ time: NOW })
    await page.goto(url, { timeout: 300_000 })
    await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" })
    await page.evaluate((dir) => { document.documentElement.dir = dir }, dir)
    await page.waitForTimeout(1500)
    await prepare(page)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(500)
    await writeFile(path.join(out, `${name}-${dir}.png`), await page.screenshot())
    await page.close()
  }
}
const session = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
try {
  await shoot("session", session, async (page) => {
    await page.locator(".transcript").getByText("Plain paragraph").waitFor()
    await page.locator(".transcript").getByText("Reasoning").first().click()
    await page.locator(".transcript").getByText("Checking steps").first().waitFor()
  })
  await shoot("session-filter", session, async (page) => { await page.locator("summary.agent-filter:visible").first().click(); await page.locator(".sidebar-filter-panel").waitFor() })
  await shoot("session-filter-keyboard", session, async (page) => {
    await page.locator("summary.agent-filter:visible").first().click()
    await page.locator(".sidebar-filter-panel input").first().waitFor()
    await page.keyboard.press("Tab")
    await page.keyboard.press("Tab")
  })
  await shoot("desk", `${preview.origin}/`)
  fixture.status = "busy"
  await shoot("session-busy", session, (page) => page.locator(".direct-split[data-busy], .direct-more:not(.idle)").first().waitFor().catch(() => {}))
} finally {
  await browser.close()
  await preview.close()
}
