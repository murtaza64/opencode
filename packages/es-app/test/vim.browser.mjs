import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import { createServer } from "vite"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const fixture = await createFixture()
process.env.OPENCODE_URL = fixture.url
process.env.ES_DASHBOARD_URL = fixture.url
const vite = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
})
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/*", (route) =>
  new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
)
const artifacts = fileURLToPath(new URL("../artifacts/vim/", import.meta.url))
await mkdir(artifacts, { recursive: true })
const editor = () => page.locator(".float-editor textarea, .prompt-box:not([inert]) textarea")
const position = () => editor().evaluate((el) => el.selectionStart)
const normal = async (pos) => {
  await editor().focus()
  if (await editor().evaluate((el) => el.classList.contains("vim-insert"))) await editor().press("Escape")
  await editor().evaluate((el, pos) => el.setSelectionRange(pos, pos), pos)
}
const nativeComparison = async (start, keys) => {
  await editor().evaluate((el, start) => {
    document.querySelector("#native-reference")?.remove()
    const reference = document.createElement("textarea")
    reference.id = "native-reference"
    const style = getComputedStyle(el)
    for (const name of style) reference.style.setProperty(name, style.getPropertyValue(name))
    reference.style.cssText += `;position:fixed;top:0;left:0;width:${el.getBoundingClientRect().width}px;height:${el.getBoundingClientRect().height}px;opacity:0;pointer-events:none;`
    reference.value = el.value
    reference.dir = el.dir
    document.body.append(reference)
    reference.focus()
    reference.setSelectionRange(start, start)
  }, start)
  const reference = page.locator("#native-reference")
  const expected = []
  for (const key of keys) {
    await reference.press(key === "j" ? "ArrowDown" : "ArrowUp")
    expected.push(await reference.evaluate((el) => el.selectionStart))
  }
  await normal(start)
  for (const [index, key] of keys.entries()) {
    await editor().press(key)
    if ((await position()) !== expected[index])
      console.log(
        "movement mismatch",
        { start, keys, index, expected },
        await editor().evaluate(async (el) => {
          const { textareaLayout } = await import("/src/textarea-layout.ts")
          const layout = textareaLayout(el)
          return JSON.stringify({
            pos: el.selectionStart,
            width: el.clientWidth,
            nativeWidth: document.querySelector("#native-reference").clientWidth,
            points: layout.points.filter((p) => p.pos < 100),
            rows: layout.rows.map((row) => [row[0], row.at(-1)]),
          })
        }),
      )
    expect(await position(), `native comparison ${start} ${keys.slice(0, index + 1).join("")}`).toBe(expected[index])
  }
  await reference.evaluate((el) => el.remove())
}

try {
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await editor().fill("inline wrapping words ".repeat(10))
  await nativeComparison(7, ["j", "k"])
  await editor().press("Control+e")
  await expect(page.locator(".relative-lines")).toBeVisible()
  const text =
    "wide words and narrow iii WWW ".repeat(12) +
    "\nshort\n" +
    "another longer row with words ".repeat(14) +
    "\n\nlast\n"
  await editor().fill(text)
  await nativeComparison(12, ["j", "j", "j", "j", "j", "k", "k", "k"])
  await normal(12)
  await editor().pressSequentially("3j")
  const counted = await position()
  await normal(12)
  await editor().pressSequentially("jjj")
  expect(await position()).toBe(counted)
  await normal(12)
  await editor().pressSequentially("gj")
  expect(await position()).toBe(text.indexOf("\nshort") + 6)
  await editor().pressSequentially("gj")
  expect(await position()).toBe(text.indexOf("another") + 12)
  await editor().pressSequentially("2gk")
  expect(await position()).toBe(12)
  await expect(page.locator('.relative-lines [data-line="1"]')).toHaveText("1")
  await normal(text.indexOf("another") + 12)
  await editor().press("l")
  await expect(page.locator('.relative-lines [data-line="1"]')).toHaveText("2")
  await expect(page.locator('.relative-lines [data-line="3"]')).toHaveText("3")
  await expect(page.locator('.relative-lines [data-line="4"]')).toHaveText("1")
  await page.screenshot({ path: `${artifacts}/desktop.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  await nativeComparison(12, ["j", "j", "j", "j", "k", "k"])
  await editor().evaluate((el) => {
    el.style.fontSize = "18px"
    el.style.tabSize = "4"
  })
  await editor().fill("\talpha beta \u{1f469}\u200d\u{1f4bb} e\u0301 ".repeat(12) + "\n\tx\n\tlonger third line\n")
  await nativeComparison(3, ["j", "j", "j", "k"])
  await page.evaluate(() => {
    document.documentElement.dir = "rtl"
  })
  await expect.poll(() => editor().evaluate((el) => getComputedStyle(el).direction)).toBe("ltr")
  await expect(page.locator(".relative-lines")).toHaveAttribute("dir", "ltr")
  await editor().fill("مرحبا بالعالم هذا نص طويل للتجربة ".repeat(12) + "\nREADME.md /tmp/example 123\n")
  await nativeComparison(3, ["j", "j", "j", "k"])
  await page.screenshot({ path: `${artifacts}/rtl.png` })
  await page.evaluate(() => {
    document.documentElement.dir = "ltr"
  })
  await expect(page.locator(".relative-lines")).toHaveAttribute("dir", "rtl")
  expect(
    await page.locator(".relative-lines").evaluate((gutter) => {
      const editor = gutter.parentElement.querySelector("textarea")
      return Math.abs(gutter.getBoundingClientRect().right - editor.getBoundingClientRect().right)
    }),
  ).toBeLessThan(1)
  await editor().fill("\talpha beta \u{1f469}\u200d\u{1f4bb} e\u0301 ".repeat(12) + "\n\tx\n\tlonger third line\n")
  expect(
    await editor().evaluate(async (el) => {
      const { textareaLayout } = await import("/src/textarea-layout.ts")
      el.style.fontFamily = '"VimLoaded", sans-serif'
      const before = textareaLayout(el)
      const font = new FontFace("VimLoaded", 'local("Courier New")')
      document.fonts.add(font)
      await document.fonts.load("18px VimLoaded")
      await document.fonts.ready
      return before !== textareaLayout(el)
    }),
  ).toBe(true)
  await nativeComparison(3, ["j", "j", "j", "k"])
  await normal(3)
  await editor().pressSequentially("2gj")
  expect(await position()).toBe((await editor().inputValue()).indexOf("\tlonger") + 3)
  await editor().fill("\u{1f469}\u200d\u{1f4bb}e\u0301x\nnext\n")
  await normal(0)
  await editor().press("l")
  expect(await editor().evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([5, 7])
  await editor().press("h")
  expect(await editor().evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([0, 5])
  await editor().press("x")
  await expect(editor()).toHaveValue("e\u0301x\nnext\n")
  await editor().press("u")
  await expect(editor()).toHaveValue("\u{1f469}\u200d\u{1f4bb}e\u0301x\nnext\n")
  await editor().press("G")
  expect(await position()).toBe((await editor().inputValue()).length)
  await expect(page.locator('.relative-lines [data-line="3"]')).toHaveClass("current")
  await editor().fill("scrolling wrapped line with some detail ".repeat(8) + "\n" + "next line\n".repeat(70))
  await normal(0)
  await editor().press("G")
  expect(await editor().evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await expect(page.locator('.relative-lines [data-line="72"]')).toHaveClass("current")
  await page.screenshot({ path: `${artifacts}/mobile-scrolled.png` })
  await editor().pressSequentially("gg")
  expect(await position()).toBe(0)
  expect(await editor().evaluate((el) => el.scrollTop)).toBeLessThan(30)
  await editor().press("i")
  await editor().press("Enter")
  await expect(page.locator('.relative-lines [data-line="2"]')).toHaveClass("current")
  const draft = await editor().inputValue()
  await editor().press("Control+e")
  await expect(editor()).toHaveValue(draft)
  await editor().press("Control+e")
  await expect(editor()).toHaveValue(draft)
  expect(await position()).toBe(1)
  await editor().press("Alt+m")
  await editor().press("Alt+m")
  await editor().press("Alt+m")
  await expect(editor()).toHaveValue(draft)
  await normal(0)
  await editor().pressSequentially("gg")
  await expect.poll(() => page.locator('.relative-lines [data-line="1"]').count()).toBe(1)
  const alignment = await editor().evaluate(async (el) => {
    const { textareaLayout } = await import("/src/textarea-layout.ts")
    const layout = textareaLayout(el)
    const repeated = textareaLayout(el)
    const errors = Array.from(document.querySelectorAll(".relative-lines span")).map((label) => {
      const range = document.createRange()
      range.selectNodeContents(label)
      return Math.abs(
        range.getBoundingClientRect().top -
          (el.getBoundingClientRect().top +
            el.clientTop +
            layout.lines[Number(label.dataset.line) - 1].top -
            el.scrollTop),
      )
    })
    return { cached: repeated === layout, errors }
  })
  expect(alignment.cached).toBe(true)
  expect(Math.max(...alignment.errors)).toBeLessThan(1)
  await page.screenshot({ path: `${artifacts}/mobile.png` })
  await editor().fill("fractional line height\n".repeat(2500))
  await normal(0)
  const metrics = await editor().evaluate(async (el) => {
    const { textareaLayout } = await import("/src/textarea-layout.ts")
    const layout = textareaLayout(el)
    const start = performance.now()
    const same = Array.from({ length: 100 }, () => textareaLayout(el) === layout).every(Boolean)
    return {
      rows: layout.rows.length,
      last: layout.points.at(-1).row,
      cached: same,
      cached100ms: performance.now() - start,
    }
  })
  expect(metrics.rows).toBe(2501)
  expect(metrics.last).toBe(2500)
  expect(metrics.cached).toBe(true)
  await editor().pressSequentially("999999j")
  expect(await position()).toBe((await editor().inputValue()).length)
  await editor().pressSequentially("999999k")
  expect(await position()).toBe(0)
  console.log("Large-buffer layout", metrics)
  expect(fixture.calls.filter((call) => call.method !== "GET")).toHaveLength(0)
  expect(errors).toEqual([])
  console.log(
    "PASS visual Vim: native Arrow comparison, counts, logical columns, Unicode, gutter, resize/font/tabs, scrolling, drafts; screenshots:",
    artifacts,
  )
} finally {
  await browser.close()
  await vite.close()
  await fixture.close()
}
