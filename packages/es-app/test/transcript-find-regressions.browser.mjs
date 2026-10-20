import { createRequire } from "node:module"
import { startFindPreview } from "./transcript-find-preview.mjs"
import { closeFindBrowser } from "./find-browser.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startFindPreview()
const fixture = preview.fixture
fixture.messages[100].parts[0].text = "progressneedle in earlier history"
const server = await chromium.launchServer({ channel: "chrome", headless: true })
const browser = await chromium.connect(server.wsEndpoint())
const page = await browser.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const find = () => page.getByRole("search", { name: "Find in transcript" })
const input = () => find().getByRole("searchbox")
const matches = () => find().locator(".find-result")
let held = false
let stream
await page.route("**/oc/session/ses_a/message?**", (route) => {
  if (held && new URL(route.request().url()).searchParams.get("before") === "msg_00085") fixture.holdMessages.set("ses_a", true)
  return route.continue()
})
const updates = () => setInterval(() => fixture.emit("message.part.delta", {
  sessionID: "ses_a", messageID: "msg_00244", partID: "part_244", field: "text", delta: " ",
}), 20)
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-find-message]")).toHaveCount(80)
  await page.keyboard.press("Control+f")
  await input().fill("needle")
  await expect(matches()).toHaveCount(2)

  // The new result must publish while updates are still arriving, not after
  // stopping the stream and giving a restarted debounce timer time to expire.
  fixture.emit("message.part.delta", { sessionID: "ses_a", messageID: "msg_00244", partID: "part_244", field: "text", delta: " needle" })
  stream = updates()
  await expect(matches()).toHaveCount(3)
  clearInterval(stream)

  await input().fill("progressneedle")
  await expect(matches()).toHaveCount(0)
  held = true
  stream = updates()
  await find().getByRole("button", { name: "Search earlier history" }).click()
  await expect.poll(() => fixture.messageReplies.length).toBeGreaterThan(0)
  await expect(matches()).toHaveCount(1)
  await expect(find()).toContainText("Reading history")
  clearInterval(stream)

  // This earlier row was indexed privately, never mounted in the reader.
  await matches().first().click()
  await expect(page.getByRole("region", { name: "Selected transcript match" })).toContainText("msg_00100")
  fixture.messages = fixture.messages.filter((message) => message.info.id !== "msg_00100")
  fixture.emit("message.removed", { sessionID: "ses_a", messageID: "msg_00100" })
  await expect(matches()).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Selected transcript match" })).toHaveCount(0)
  await expect(page.locator("[data-find-message]")).toHaveCount(80)
  await expect(find()).not.toContainText("Reading history")
  await expect.poll(() => fixture.abortedMessages.length).toBeGreaterThan(0)
  held = false
  fixture.holdMessages.clear()
  fixture.messageReplies.splice(0).forEach((reply) => reply())

  fixture.messages = fixture.messages.slice(-80)
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-find-message]")).toHaveCount(80)
  await page.keyboard.press("Control+f")
  await input().fill("needle")
  await find().getByRole("button", { name: "Search earlier history" }).click()
  await expect(find()).toContainText("Full selected transcript")
  await expect(find()).toContainText("80 messages indexed")
  await expect(find().getByRole("alert")).toHaveCount(0)
  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  expect(errors).toEqual([])
  console.log("PASS Find review regressions: continuous data updates publish, earlier-page hits visible during paging, earlier removed SSE clears hit/excerpt, exact-80 terminal page")
} finally {
  clearInterval(stream)
  fixture.holdMessages.clear()
  fixture.messageReplies.splice(0).forEach((reply) => reply())
  await page.unrouteAll({ behavior: "ignoreErrors" })
  await closeFindBrowser(server)
  await preview.close()
}
