// Icon chips (human #420), private preview variant, on the additive icon-chip fixture cases. Every tool call and every
// closed group renders icon-first (.tool-run[data-compact], .tool-chip[data-compact], .tool-run-icon[data-tool][data-status]);
// failed, running and unknown-exit calls say so in words beside the icon; settled mail is a content-width line with party and kind visible.
// Hover or keyboard focus shows the facts; Enter expands the full original details; Escape closes and returns focus.
// Icon-first rows are the base design: the same with Living activity off (default) and on (it adds Filament only).
// Edits show the pencil, the file and the tool's confirmed +/- counts; each icon carries data-filament-icon and a
// size tier inside a fixed box.
// Run from packages/es-app: node test/icon-chips.browser.mjs   (SCREENSHOT_DIR=<dir>)
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startToolRunsPreview } from "./tool-runs-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-icon-chips")
mkdirSync(shots, { recursive: true })
const preview = await startToolRunsPreview(0, { iconCases: true })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.context().route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  page.on("pageerror", (error) => errors.push(error.message))
  const run = (part) => page.locator(`.tool-run[data-timeline-part-ids*="${part}"]`)
  const chip = (part) => page.locator(`.tool-chip[data-timeline-part-id="${part}"]`)
  const icons = (locator) => locator.locator(".tool-run-icon").evaluateAll((items) => items.map((item) => [item.dataset.tool, item.dataset.status]))
  const mail = page.locator('.mail-activity[data-mail-message-id="msg_2006"]')

  // Living activity off (default): icon-first rows, no Filament.
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(page.getByRole("button", { name: "Living activity (Filament)" })).toHaveAttribute("aria-pressed", "false")
  await expect(run("p71_ra")).toHaveAttribute("data-compact", "true")
  await expect(page.locator(".filament-canvas")).toHaveCount(0)
  const grammar = () => page.evaluate(() => [...document.querySelectorAll(".tool-run-icon")].map((icon) =>
    [icon.dataset.filamentIcon, icon.dataset.tool, icon.dataset.status, icon.dataset.size].join("|")))
  // Rows render progressively; compare only once the oldest run is on the page too.
  await expect(run("p11_read")).toHaveCount(1)
  const off = await grammar()
  // The initial viewport shows a group with a failure, single calls, a failed call, mail and a running call.
  for (const target of [run("p74_sa"), chip("p81_one"), chip("p91_err"), chip("p95_run"), mail])
    await expect(target).toBeInViewport()
  await page.screenshot({ path: join(shots, "living-off.png") })

  // Living activity on: the same rows, plus Filament; the setting persists.
  await page.getByRole("button", { name: "Living activity (Filament)" }).click()
  await expect(page.locator(".filament-canvas")).toHaveCount(1)
  await page.reload()
  await expect(page.getByRole("button", { name: "Living activity (Filament)" })).toHaveAttribute("aria-pressed", "true")
  await expect(run("p71_ra")).toHaveAttribute("data-compact", "true")
  await expect(run("p11_read")).toHaveCount(1)
  expect(await grammar()).toEqual(off)
  await page.screenshot({ path: join(shots, "living-on.png") })

  // Groups: one icon per call, the count, failures in words.
  expect(await icons(run("p71_ra"))).toEqual([["read", "ok"], ["grep", "ok"], ["glob", "ok"]])
  expect(await icons(run("p74_sa"))).toEqual([["bash", "ok"], ["bash", "failed"]])
  await expect(run("p74_sa").locator(".tool-run-state")).toHaveText("1 failed")
  // Every icon is the Filament anchor for its own call, inside a fixed 20px box; the glyph follows the size tier.
  await expect(run("p74_sa").locator(".tool-run-icon").first()).toHaveAttribute("data-filament-icon", "p74_sa")
  await expect(run("p74_sa").locator(".tool-run-icon").first()).toHaveAttribute("data-size", "XS")
  expect(await page.locator(".tool-run-icon").evaluateAll((icons) => [...new Set(icons.map((icon) => Math.round(icon.getBoundingClientRect().width)))])).toEqual([20])
  expect(await run("p74_sa").locator(".tool-run-icon svg").evaluateAll((svgs) => svgs.map((svg) => Math.round(svg.getBoundingClientRect().width)))).toEqual([12, 12])
  // A running call has no known size yet: neutral, not XS.
  await expect(chip("p95_run").locator(".tool-run-icon")).toHaveAttribute("data-size", "unknown")
  expect(await chip("p95_run").locator(".tool-run-icon svg").evaluate((svg) => Math.round(svg.getBoundingClientRect().width))).toBe(16)
  // No glyph or count is drawn beside the spine by the rows themselves: one icon per call.
  expect(await page.locator(".tool-run-icon").count()).toBe(await page.locator("[data-filament-icon]:not(.mail-activity-kind)").count())
  // Edits: pencil, file and confirmed counts; a patch summarises its files and lists them when opened.
  await expect(chip("p83_edit").locator(".tool-chip-state")).toHaveText("a.ts +3 −1")
  await expect(chip("p83_edit").locator(".tool-run-icon use")).toHaveAttribute("href", /pencil-line/)
  await expect(chip("p85_patch").locator(".tool-chip-state")).toHaveText("3 files +12 −3")
  await chip("p85_patch").locator(".tool-chip-summary").click()
  for (const file of ["a.ts", "b.ts", "c.ts"]) await expect(chip("p85_patch").locator(".tool-chip-member")).toContainText(file)
  await chip("p85_patch").locator(".tool-chip-summary").click()
  // Mail glyphs are Filament anchors too.
  await expect(mail.locator(".mail-activity-kind")).toHaveAttribute("data-filament-icon", "mail_icon_1")
  await expect(run("p22_fail")).toHaveAttribute("data-compact", "true")
  await expect(run("p22_fail").locator(".tool-run-state")).toHaveText("1 failed")
  // Single calls: icon first; failure, uncertainty and running stated in words with what ran.
  expect(await icons(chip("p81_one"))).toEqual([["read", "ok"]])
  await expect(chip("p81_one")).toHaveAttribute("data-filament-anchor", "p81_one")
  await expect(chip("p81_one").locator(".tool-chip-state")).toHaveText("session.tsx")
  await expect(run("p71_ra").locator(".tool-run-count")).toHaveText("3 calls")
  await expect(chip("p91_err").locator(".tool-chip-state")).toHaveText("failed · make lint · Error: lint failed in src/a.ts")
  await expect(chip("p92_exit").locator(".tool-chip-state")).toHaveText("exit unknown · ./deploy.sh")
  await expect(chip("p95_run").locator(".tool-chip-state")).toHaveText("running · bun run build")
  await expect(chip("p95_run").locator(".tool-chip-summary")).toHaveAttribute("aria-busy", "true")
  // Failure reads without colour: the words are visible text, not a tint.
  expect(await chip("p91_err").locator(".tool-chip-state").evaluate((el) => el.getBoundingClientRect().width > 100)).toBe(true)

  // Hover and focus show the facts; Enter opens the full original chip; Escape returns focus.
  const single = chip("p83_edit").locator(".tool-chip-summary")
  await expect(single).toHaveAccessibleName(/^Edit, a\.ts \+3 −1, size /)
  await single.hover()
  await expect(chip("p83_edit").locator(".tool-run-preview")).toBeVisible()
  await page.screenshot({ path: join(shots, "hover.png") })
  await page.mouse.move(0, 0)
  await single.focus()
  await page.keyboard.press("Enter")
  await expect(chip("p83_edit")).toHaveAttribute("data-open", "true")
  await expect(chip("p83_edit").locator(".tool-chip-member [data-component]").first()).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(chip("p83_edit")).toHaveAttribute("data-compact", "true")
  await expect(single).toBeFocused()
  const summary = run("p74_sa").locator(".tool-run-summary")
  await summary.focus()
  await page.keyboard.press("Enter")
  await expect(run("p74_sa").locator(".tool-run-member")).toHaveCount(2)
  await page.keyboard.press("Escape")
  await expect(run("p74_sa")).toHaveAttribute("data-compact", "true")
  await expect(summary).toBeFocused()

  // Settled mail: glyph, party and kind visible; full details when opened.
  const mailSummary = mail.locator(".mail-activity-summary")
  await expect(mailSummary).toHaveAttribute("data-compact", "true")
  await expect(mailSummary).toHaveAccessibleName(/^Mail from ux-feel: Notice/)
  // Party and kind stay visible at rest.
  await expect(mail.locator(".mail-activity-party")).toBeVisible()
  await expect(mail.locator(".mail-activity-purpose")).toHaveText("Notice")
  await mailSummary.focus()
  await page.keyboard.press("Enter")
  await expect(mail).toHaveAttribute("open", "")
  await expect(mail.locator(".mail-activity-details")).toContainText("mail_icon_1")
  await page.keyboard.press("Enter")

  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await expect(run("p71_ra")).toHaveAttribute("data-compact", "true")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(shots, "rtl.png") })
  expect(errors).toEqual([])
  console.log(`PASS icon chips: icon-first with Living off and on (same rows; toggle adds Filament only, persists); data-filament-icon anchors (tools + mail), fixed 20px box with size tiers, unknown neutral; edit pencil + file + confirmed counts, multi-file patch summary + expansion; groups (ok + failed), single ok/failed/exit-unknown/running calls and mail icon-first; RTL; screenshots ${shots}`)
} finally {
  await preview.close()
  await browser.close()
}
