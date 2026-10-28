// Session info panel (dotfiles#240): the session's cost reads at a glance on a labelled presentation
// scale ($1 · $10 · $100 decades, not a budget) and an unknown cost is never shown as $0; Details wraps
// long values inside the panel; todos sit borderless with the current item emphasised. LTR and RTL.
// Disposable fixture. Run from packages/es-app: node test/info-panel.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startPanelPreview()
const fixture = preview.fixture
const user = { info: { id: "msg_user", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: 1 } }, parts: [] }
const assistant = cost => ({ info: { id: "msg_reply", sessionID: "ses_a", role: "assistant", agent: "build", mode: "build", parentID: "msg_user", providerID: "fixture", modelID: "test",
  path: { cwd: directory, root: directory }, ...(cost === undefined ? {} : { cost }), tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 2, completed: 3 } }, parts: [] })
fixture.todos = new Map([["ses_a", [
  { content: "Read the design", status: "completed", priority: "high" },
  { content: "Move the resize handles onto the seams", status: "in_progress", priority: "high" },
  { content: "Check RTL", status: "pending", priority: "medium" },
]]])
const browser = await chromium.launch({ channel: "chrome", headless: true })
const LONG = "~/editspaces/opencode/lanes/a-very-long-lane-name-that-does-not-fit/repos/murtaza64/opencode/packages/es-app/src/components/session-info.tsx"

let failed = false
const check = async (name, { cost, dir = "ltr" }, verify) => {
  fixture.messages = [user, assistant(cost)]
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  await context.addInitScript(() => { try { localStorage.setItem("es-app-right-open", "1"); localStorage.removeItem("es-app-right-width") } catch {} })
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  try {
    await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
    const panel = page.locator(".session-info")
    await expect(panel.locator(".info-cost")).toBeVisible({ timeout: 120_000 })
    await page.evaluate(dir => { document.documentElement.dir = dir }, dir)
    await panel.locator(".info-details > summary").click()
    await panel.locator(".info-row.cwd bdi").evaluate((el, text) => { el.textContent = text }, LONG)
    if (shots) await panel.screenshot({ path: path.join(shots, `${name}.png`) })
    // Nothing in the panel is wider than the panel.
    const overflow = await panel.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth,
      wide: [...el.querySelectorAll("*")].filter(child => child.getBoundingClientRect().right > el.getBoundingClientRect().right + 1 || child.getBoundingClientRect().left < el.getBoundingClientRect().left - 1).map(child => child.className || child.tagName) }))
    assert(overflow.scroll <= overflow.client + 1 && overflow.wide.length === 0, `${name}: Details stays inside the panel ${JSON.stringify(overflow)}`)
    // Todos: no outline; the current item is emphasised, done is quieter than pending.
    const todos = await panel.locator(".todo-panel").evaluate(el => {
      const style = getComputedStyle(el)
      const item = status => getComputedStyle(el.querySelector(`li[data-status="${status}"]`))
      return { border: style.borderTopWidth, weight: item("in_progress").fontWeight, pending: item("pending").color, done: item("completed").color, current: item("in_progress").color }
    })
    assert.equal(todos.border, "0px", `${name}: todos have no outline`)
    assert(Number(todos.weight) >= 600, `${name}: the current todo is emphasised ${JSON.stringify(todos)}`)
    assert.notEqual(todos.done, todos.pending, `${name}: done and pending todos differ ${JSON.stringify(todos)}`)
    await verify(panel)
    console.log(`PASS ${name}`)
  } catch (error) {
    failed = true
    console.error(`FAIL ${name}: ${error.message}`)
  } finally {
    await context.close()
  }
}

try {
  await check("cost-12", { cost: 12.34 }, async panel => {
    await expect(panel.locator(".info-cost")).toHaveText("$12.34")
    await expect(panel.locator(".info-cost")).toHaveAttribute("data-decade", "2")
    await expect(panel.getByRole("img", { name: /Session cost \$12\.34, estimate\. Scale marks \$1, \$10 and \$100 \(presentation only, not a budget\)/ })).toBeVisible()
    const fill = await panel.locator(".info-cost-fill").evaluate(el => getComputedStyle(el).transform)
    // log10(12.34) + 1 = 2.09 of 3 decades.
    assert.match(fill, /^matrix\(0\.69/, `fill on the log scale: ${fill}`)
  })
  await check("cost-140-rtl", { cost: 140, dir: "rtl" }, async panel => {
    await expect(panel.locator(".info-cost")).toHaveAttribute("data-decade", "3")
    const origin = await panel.locator(".info-cost-fill").evaluate(el => getComputedStyle(el).transformOrigin)
    assert(origin.startsWith(`${Math.round(parseFloat(origin))}`) && parseFloat(origin) > 1, `RTL fill grows from the inline start (right): ${origin}`)
  })
  await check("cost-unknown", { cost: undefined }, async panel => {
    await expect(panel.locator(".info-cost")).toHaveText("—")
    await expect(panel.locator(".info-cost")).toHaveAttribute("title", /unknown/)
    await expect(panel.locator(".info-cost-scale")).toHaveCount(0)
  })
} finally {
  await browser.close()
  await preview.close()
}
if (failed) process.exit(1)
console.log("info-panel: PASS")
