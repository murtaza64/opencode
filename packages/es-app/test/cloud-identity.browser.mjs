import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const original = { ...preview.ledger.cloudLanes[0] }
preview.ledger.cloudLanes.push({ ...original, lane: "cloud-second", owner: "wingman:second-task" })
const browser = await chromium.launch({ channel: "chrome", headless: true })
let releaseHeld = () => undefined
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  await page.goto(preview.url)
  await page.locator(".sidebar .cloud-discovery summary").click()
  await page.getByRole("button", { name: "Pin cloud agent cloud-review", exact: true }).click()
  await page.getByRole("button", { name: "Pin cloud agent cloud-second", exact: true }).click()
  const open = owner => page.locator(`.pinned-section [data-cloud-owner="${owner}"] a`)
  await open("wingman:fixture-task").click()
  const details = page.getByRole("region", { name: "Cloud agent details" })
  await details.getByRole("button", { name: "Load transcript", exact: true }).click()
  await expect(details).toContainText("not executable</script> · wingman:fixture-task")
  await open("wingman:second-task").click()
  await expect(details).not.toContainText("not executable</script> · wingman:fixture-task")
  await details.getByRole("button", { name: "Load transcript", exact: true }).click()
  await expect(details).toContainText("not executable</script> · wingman:second-task")
  await open("wingman:fixture-task").click()
  const beforeRace = preview.ledger.transcriptCalls
  await context.route("**/es/api/wingman/transcript?*", route => {
    preview.ledger.cloudLanes[0].owner = "wingman:replacement"
    return route.continue()
  })
  await details.getByRole("button", { name: "Load transcript", exact: true }).click()
  await expect(details).toContainText("Transcript unavailable. Try again later.")
  expect(preview.ledger.transcriptCalls).toBe(beforeRace)
  await expect(details).not.toContainText("not executable</script>")
  await context.unroute("**/es/api/wingman/transcript?*")
  preview.ledger.cloudLanes[0].owner = original.owner
  await page.getByRole("button", { name: "Refresh cloud source", exact: true }).click()
  const close = details.getByRole("button", { name: "Close transcript", exact: true })
  if (await close.count()) await close.click()
  await context.route("**/es/api/wingman/transcript?*", route => route.fulfill({ json: { owner: "wingman:wrong-owner", turns: [{ reply: "WRONG OWNER CONTENT" }] } }))
  await details.getByRole("button", { name: "Load transcript", exact: true }).click()
  await expect(details).toContainText("Transcript owner changed or could not be verified")
  await expect(details).not.toContainText("WRONG OWNER CONTENT")
  await context.close()

  preview.ledger.cloudLanes = [{ ...original }]
  const parallel = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await parallel.addInitScript(() => localStorage.setItem("es-app-cloud-pins", JSON.stringify([
    { editspace: "fixture", lane: "cloud-review", owner: "wingman:fixture-task" },
    { editspace: "other", lane: "cloud-review", owner: "wingman:fixture-task" },
  ])))
  await parallel.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  let holdOther = false
  let held = false
  const gate = new Promise(resolve => { releaseHeld = resolve })
  await parallel.route("**/es/api/wingman?es=other", async route => { if (holdOther) { held = true; await gate } await route.continue() })
  const second = await parallel.newPage()
  await second.goto(preview.url)
  const cloud = second.getByRole("region", { name: "Cloud agents", exact: true })
  const other = cloud.locator(".home-agent").filter({ hasText: "other · wingman:fixture-task" })
  await expect(other).toContainText("Reviewing the attention module")
  preview.ledger.cloudLanes[0].activity = "New report from concurrent poll"
  holdOther = true
  await cloud.getByRole("button", { name: "Refresh cloud lanes", exact: true }).click()
  await expect.poll(() => held).toBe(true)
  const first = cloud.locator(".home-agent").filter({ hasText: "fixture · wingman:fixture-task" })
  await first.getByRole("button", { name: "Load transcript", exact: true }).click()
  await expect(first).toContainText("Synthetic cloud transcript")
  await expect(other).not.toContainText("New report from concurrent poll")
  holdOther = false
  releaseHeld()
  await expect(other).toContainText("New report from concurrent poll")
  await parallel.close()
  const migrated = await browser.newContext()
  await migrated.addInitScript(() => localStorage.setItem("es-app-cloud-pins", JSON.stringify([
    JSON.stringify(["wingman", "fixture", "cloud-review"]),
    { editspace: "fixture", lane: "cloud-review", owner: "wingman:fixture-task" },
  ])))
  await migrated.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const legacy = await migrated.newPage()
  await legacy.goto(preview.url)
  await expect(legacy.locator('.pinned-section [data-cloud-owner="wingman:fixture-task"]')).toHaveCount(1)
  await expect.poll(() => legacy.evaluate(() => JSON.parse(localStorage.getItem("es-app-cloud-pins")))).toEqual([{ editspace: "fixture", lane: "cloud-review", owner: "wingman:fixture-task" }])
  await migrated.close()
  console.log("PASS cloud identity: query A→B resets transcript, server expected-owner race rejects, response-owner mismatch hidden, overlapping full/scoped polls retain unrelated project results, legacy pins bind/deduplicate after owner observation")
} finally { releaseHeld(); await browser.close(); await preview.close() }
