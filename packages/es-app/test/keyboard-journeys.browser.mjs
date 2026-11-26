// Keyboard-only journeys (dotfiles#254, DD keyboard-workflow#50) on the session page, Desk, Agents and
// Usage, each from three focus states: composer in Insert, composer in Normal, nothing focused.
// Prints a works yes/no matrix; with --assert it fails unless every expected cell is yes.
// Disposable fixture plus a local voice stub: no capture, no model, nothing sent.
// Run from packages/es-app: node test/keyboard-journeys.browser.mjs [--assert] [session|desk|agents|usage ...]
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const args = process.argv.slice(2)
const strict = args.includes("--assert")
const PAGES = { session: `/session/ses_a?directory=${encodeURIComponent(directory)}`, desk: "/", agents: "/agents", usage: "/usage" }
const pages = args.filter((arg) => arg in PAGES)
const STATES = ["insert", "normal", "none"]
const DRAFT = "keep this draft"

const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const rows = []
const errors = []
try {
  for (const name of pages.length ? pages : Object.keys(PAGES)) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, userAgent: "Editspace fixture Electron/42.3.3", reducedMotion: "reduce" })
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }))
    await context.addInitScript(({ directory }) => localStorage.setItem("es-app:front-desk:1", JSON.stringify({ session: "ses_b", directory })), { directory })
    await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
    const page = await context.newPage()
    page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`))
    await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "here", label: "Here", remote: false, profile: "work", hosts: [], work: [] } }))
    await page.route("**/__es/events", (route) => route.fulfill({ json: { protocol: null } }))
    await page.route("**/__es/voice{,/**}", (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === "/__es/voice") return route.fulfill({ json: { available: true, state: "idle" } })
      if (path.endsWith("/stop")) return route.fulfill({ json: { ok: true, text: "spoken words" } })
      return route.fulfill({ json: { ok: true } })
    })
    // One retry: a loaded host occasionally leaves a fixture page without its composer on first paint.
    const load = async (retry = true) => {
      await page.goto(`${preview.origin}${PAGES[name]}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
      const ready = await page.waitForFunction(() => document.querySelectorAll(".prompt-box textarea").length > 0, null, { timeout: 20_000 }).then(() => true, () => false)
      if (!ready && retry) return load(false)
      if (!ready) throw new Error(`${name}: no composer after two loads`)
      await page.waitForTimeout(400)
    }
    await load()
    for (const state of STATES) {
      const cell = (journey, key, works, note = "") => rows.push({ page: name, state, journey, key, works, note })
      // Each journey starts from a fresh page in the focus state under test.
      const start = async () => {
        // Porter's pane at its default for the page: closed beside a session, open beside work views.
        await page.evaluate(() => { localStorage.removeItem("es-app:companion:session"); localStorage.removeItem("es-app:companion:work") })
        await load()
        await page.evaluate((draft) => {
          const main = [...document.querySelectorAll(".prompt-box textarea")].find((el) => !el.closest(".desk-companion")) ??
            document.querySelector(".desk-companion:not(.closed) .prompt-box textarea")
          main.focus()
          main.value = ""
          document.execCommand("insertText", false, draft)
        }, DRAFT)
        if (state === "normal") await page.keyboard.press("Escape")
        if (state === "none") await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
      }
      const draftKept = () => page.evaluate((draft) => [...document.querySelectorAll(".prompt-box textarea")].some((el) => el.value === draft), DRAFT)
      const region = () => page.evaluate(() => {
        const el = document.activeElement
        if (!el || el === document.body) return "body"
        if (el.closest(".desk-companion")) return el.matches("textarea") ? "porter-composer" : "porter"
        if (el.closest(".prompt-box")) return "composer"
        if (el.closest("nav.sidebar")) return "sidebar"
        if (el.closest(".transcript")) return "transcript"
        if (el.closest(".content")) return "content"
        return el.tagName.toLowerCase()
      })
      const helpOpen = () => page.getByRole("dialog", { name: "Keyboard shortcuts" }).isVisible()

      for (const key of ["Shift+Slash", "Meta+Shift+Slash", "F1"]) {
        // Plain "?" in Insert is typed text by design; the chords below are the any-mode help keys.
        if (key === "Shift+Slash" && state === "insert") continue
        await start()
        const from = await region()
        await page.keyboard.press(key)
        const open = await helpOpen()
        const kept = await draftKept()
        let back = true
        if (open) {
          await page.keyboard.press("Escape")
          back = (await region()) === from
        }
        cell("help", key === "Shift+Slash" ? "?" : key === "Meta+Shift+Slash" ? "⌘?" : key, open && kept && back, `${open ? "opens" : "no help"}${kept ? "" : ", draft changed"}${back ? "" : ", focus not returned"}`)
      }

      for (const key of [["g", "d"], ["Meta+Slash"]]) {
        // "g d" is a Normal-scope sequence; in Insert it is typed text by design.
        if (key[0] === "g" && state === "insert") continue
        await start()
        // Already typing to Porter: nothing to open.
        if ((await region()) === "porter-composer") continue
        for (const each of key) await page.keyboard.press(each)
        await page.waitForTimeout(200)
        const at = await region()
        const path = new URL(page.url()).pathname
        const works = at === "porter-composer" && path === new URL(`${preview.origin}${PAGES[name]}`).pathname && (await draftKept())
        cell("Porter", key.join(" ").replace("Meta+Slash", "⌘/"), works, `focus ${at}, path ${path}`)
        if (works && key[0] === "Meta+Slash") {
          await page.keyboard.press("Meta+Slash")
          const returned = await region()
          cell("Porter back", "⌘/ again", state === "none" ? returned !== "porter-composer" : returned === "composer" && (await draftKept()), `focus ${returned}`)
        }
      }

      {
        await start()
        preview.fixture.calls.length = 0
        await page.keyboard.press("Meta+Shift+Space")
        const stop = page.locator(".dictation-toggle[aria-label='Stop dictation and transcribe']")
        const recording = await stop.first().waitFor({ timeout: 1500 }).then(() => 1, () => 0)
        await page.keyboard.press("Meta+Shift+Space")
        await page.waitForTimeout(300)
        const sent = preview.fixture.calls.filter((call) => call.method === "POST" && /prompt|\/input|\/message/.test(call.path))
        cell("dictation", "⌘⇧Space", recording > 0 && sent.length === 0, recording ? `recording; sends ${sent.length}` : "nothing started")
      }

      for (const key of ["F6", "Control+Alt+h"]) {
        await start()
        const from = await region()
        await page.keyboard.press(key)
        const to = await region()
        const visible = await page.evaluate(() => {
          const el = document.activeElement
          return !!el && el !== document.body && getComputedStyle(el).outlineStyle !== "none" || !!el?.matches(":focus-visible")
        })
        cell("region", key.replace("Control+Alt+h", "⌃⌥H"), from !== to && to !== "body" && visible, `${from} -> ${to}${visible ? "" : " (focus not visible)"}`)
      }

      {
        // Between text boxes: F6 presses until Porter's composer is focused, then back to the first box.
        await start()
        const visits = []
        for (let i = 0; i < 6 && visits.at(-1) !== "porter-composer"; i++) {
          await page.keyboard.press("F6")
          visits.push(await region())
        }
        // Beside a session Porter's pane starts closed, so F6 has no second text box to reach; ⌘/ opens it.
        const closed = await page.locator(".desk-companion.closed").count()
        cell("text boxes", "F6…", closed ? "n/a" : visits.includes("porter-composer"), `${closed ? "Porter closed (⌘/ opens it): " : ""}${visits.join(" > ")}`)
      }

      // In Insert "f" is text and in the composer's Normal mode Vim's find-character: hints start from outside text boxes.
      if (state === "none") {
        await start()
        await page.keyboard.press("f")
        const labels = await page.locator(".kbd-hint").count()
        const kept = await draftKept()
        cell("hint overlay", "f", labels > 0 && kept, labels ? `${labels} labels` : "no labels")
        if (labels) await page.keyboard.press("Escape")
      }

      if (state !== "none") {
        await start()
        const from = await region()
        if (state === "insert") await page.keyboard.press("Escape")
        await page.keyboard.press("Escape")
        const at = await region()
        const left = at !== "composer" && at !== "porter-composer" && at !== "body" && (await draftKept())
        cell("Esc leaves composer", state === "insert" ? "Esc Esc" : "Esc", left, `focus ${at}`)
        if (left) {
          await page.keyboard.press("i")
          const back = await region()
          cell("back to composer", "i", back === from && (await draftKept()), `focus ${back}`)
        }
      }

      if (state === "none") {
        // A label opens what it marks: the sidebar's Usage link (or Agents from Usage).
        await start()
        const goal = name === "usage" ? "/agents" : "/usage"
        await page.keyboard.press("f")
        const label = await page.evaluate((goal) => {
          // The tag sits beside the link at its vertical centre: the nearest tag on that line.
          const box = document.querySelector(`nav a[href='${goal}']`)?.getBoundingClientRect()
          if (!box) return ""
          const line = [...document.querySelectorAll(".kbd-hint")].map((el) => ({ el, at: el.getBoundingClientRect() }))
            .filter(({ at }) => at.top + at.height / 2 > box.top && at.top + at.height / 2 < box.bottom)
            .sort((a, b) => Math.abs(a.at.right - box.left) - Math.abs(b.at.right - box.left))
          return line[0]?.el.textContent ?? ""
        }, goal)
        for (const letter of label) await page.keyboard.press(letter)
        await page.waitForTimeout(200)
        const path = new URL(page.url()).pathname
        cell("hint opens target", label ? `f ${label}` : "f …", path === goal, `path ${path}`)
      }

      if (state === "none" && name === "session") {
        // A label on Delete only focuses it: a one-letter slip never deletes the session.
        await start()
        preview.fixture.calls.length = 0
        await page.keyboard.press("Shift+F")
        const label = await page.evaluate(() => {
          const button = [...document.querySelectorAll(".session-page button")].find((el) => /^delete\b/i.test(el.getAttribute("aria-label") ?? el.textContent.trim()))
          const box = button?.getBoundingClientRect()
          if (!box) return ""
          const line = [...document.querySelectorAll(".kbd-hint")].map((el) => ({ el, at: el.getBoundingClientRect() }))
            .filter(({ at }) => at.top + at.height / 2 > box.top && at.top + at.height / 2 < box.bottom)
            .sort((a, b) => Math.abs(a.at.right - box.left) - Math.abs(b.at.right - box.left))
          return line[0]?.el.textContent ?? ""
        })
        for (const letter of label) await page.keyboard.press(letter)
        await page.waitForTimeout(200)
        const focused = await page.evaluate(() => /^delete\b/i.test(document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent.trim() ?? ""))
        const dialog = await page.getByRole("dialog").count() + await page.getByRole("alertdialog").count()
        const writes = preview.fixture.calls.filter((call) => call.method !== "GET" && call.path !== "/api/attention/session")
        cell("hint never deletes", label ? `F ${label}` : "F …", !!label && focused && !dialog && !writes.length, `focused Delete ${focused}; dialogs ${dialog}; writes ${writes.length}`)
      }

      {
        await start()
        const chip = await page.locator(".kbd-mode").first().textContent({ timeout: 300 }).catch(() => null)
        const want = state === "insert" ? "INSERT" : state === "normal" ? "NORMAL" : null
        cell("mode shown", "-", want ? (chip ?? "").toUpperCase().includes(want) : !chip, chip ? `shows ${chip}` : "no indicator")
      }
    }
    await context.close()
  }
} finally {
  await browser.close()
  await preview.close()
}

const width = (key) => Math.max(...rows.map((row) => String(row[key]).length), key.length)
const columns = ["page", "state", "journey", "key", "works", "note"]
console.log(columns.map((key) => key.padEnd(width(key))).join(" | "))
for (const row of rows) console.log(columns.map((key) => String(key === "works" ? (row.works === "n/a" ? "n/a" : row.works ? "yes" : "NO") : row[key]).padEnd(width(key))).join(" | "))
if (errors.length) console.log(`page errors:\n${errors.join("\n")}`)
const failed = rows.filter((row) => !row.works)
const counted = rows.filter((row) => row.works !== "n/a")
console.log(`${counted.length - failed.length}/${counted.length} cells work`)
if (strict && (failed.length || errors.length)) process.exit(1)
