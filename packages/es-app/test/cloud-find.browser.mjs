import { createRequire } from "node:module"
import { startFindPreview } from "./transcript-find-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startFindPreview()
const server = await chromium.launchServer({ channel: "chrome", headless: true })
const browser = await chromium.connect(server.wsEndpoint())
const page = await browser.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/es/api/wingman/transcript?**", async (route) => {
  const response = await route.fetch()
  const body = await response.json()
  body.turns_dropped = 17
  body.turns[0].prompt = "NEEDLE [a.*] שלום Straße"
  body.turns[0].reply = "long code ".repeat(40_000) + "needle [a.*] שלום Straße <script>not executable</script>"
  body.turns[0].events = [{ kind: "reasoning", text: "unindexed-private-event" }]
  return route.fulfill({ response, json: body })
})
const find = () => page.getByRole("search", { name: "Find in transcript" })
const input = () => find().getByRole("searchbox")
const query = async (text, count) => { await input().fill(text); await expect(find().locator(".find-result")).toHaveCount(count) }
const defaultFind = () => page.evaluate(() => {
  const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true })
  window.dispatchEvent(event)
  return !event.defaultPrevented
})
try {
  await page.goto(`${preview.origin}/cloud?es=fixture&lane=cloud-review&owner=wingman%3Afixture-task`)
  const details = page.getByRole("region", { name: "Cloud agent details", exact: true })
  await expect(details.getByRole("button", { name: "Find in loaded transcript" })).toBeDisabled()
  expect(await defaultFind()).toBe(true)
  expect(preview.ledger.transcriptCalls).toBe(0)
  await details.getByRole("button", { name: "Load transcript", exact: true }).click()
  await expect(details).toContainText("turns dropped: 17")
  const reads = preview.fixture.calls.filter((call) => call.path.includes("/message")).length
  await page.keyboard.press("Meta+f")
  await expect(input()).toBeFocused()
  await query("needle", 2)
  await expect(find()).toContainText("Loaded gateway transcript only")
  await expect(find()).not.toContainText("Full selected transcript")
  await expect(find().getByRole("button", { name: "Search earlier history" })).toHaveCount(0)
  await input().press("Enter")
  await expect(find().getByRole("status")).toContainText("1 of 2")
  await expect(details.getByRole("region", { name: "Selected transcript match" }).locator("mark")).toHaveText("NEEDLE")
  await input().press("Shift+Enter")
  await expect(find().getByRole("status")).toContainText("2 of 2")
  await query("[a.*]", 2)
  await query("STRASSE", 2)
  await query("unindexed-private-event", 0)
  await query("<script>", 1)
  await input().press("Control+Enter")
  await expect(details.getByRole("region", { name: "Selected transcript match" })).toContainText("<script>")
  expect(await page.locator(".home-agent script").count()).toBe(0)
  await page.evaluate(() => { document.documentElement.dir = "rtl"; document.documentElement.lang = "ar" })
  await query("שלום", 2)
  await input().press("Enter")
  await expect(details.getByRole("region", { name: "Selected transcript match" })).toBeInViewport()
  await input().press("Escape")
  await expect(find()).toHaveCount(0)
  expect(preview.ledger.transcriptCalls).toBe(1)
  expect(preview.fixture.calls.filter((call) => call.path.includes("/message")).length).toBe(reads)
  expect(preview.fixture.calls.some((call) => call.path.includes("wingman:"))).toBe(false)
  await details.getByRole("button", { name: "Close transcript", exact: true }).click()
  await expect(details.getByRole("button", { name: "Find in loaded transcript" })).toBeDisabled()
  expect(await defaultFind()).toBe(true)
  expect(preview.fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  expect(errors).toEqual([])
  console.log("PASS loaded cloud Find: explicit load only, private literal/case/RTL/long text, dropped scope, no event indexing, exact turn excerpt, zero OC/cloud writes or per-query gateway reads")
} finally {
  await page.unrouteAll({ behavior: "ignoreErrors" })
  await server.kill()
  await preview.close()
}
