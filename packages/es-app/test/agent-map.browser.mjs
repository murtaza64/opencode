// Agent map from Home: real-data relations (lane owner, verified handoff, subagent,
// standalone, cloud), scope/filter, selected-agent observed mail, navigation, RTL/mobile.
// Run from packages/es-app: node test/agent-map.browser.mjs
import { createRequire } from "node:module"
import path from "node:path"
import { tmpdir } from "node:os"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const artifacts = process.env.HOME_AGENTS_ARTIFACTS ?? tmpdir()
const preview = await startAttentionPreview()
const fixture = preview.fixture
const now = Date.now()
fixture.status = "busy"
fixture.laneOwners = [
  { lane: "home-agents", owner: "ses_a", status: "active", activity: "Wiring the agent map", activity_at: new Date(now - 60_000).toISOString(), activity_session: "ses_a" },
]
// A lane whose owner is not a session in this index (another machine or pruned history).
const remoteLane = { lane: "orchestrator", owner: "opencode:ses_remote", status: "active" }
fixture.handoffs = [{ lane: "home-agents", predecessor: "ses_b", successor: "ses_a" }]
const base = { projectID: "fixture", version: "1", agent: "build" }
fixture.workspaceSessions = [
  { ...base, id: "ses_child", title: "explore subagent", directory, parentID: "ses_a", time: { created: now - 5000, updated: now - 1000 } },
  { ...base, id: "ses_grandchild", title: "nested reviewer", directory, parentID: "ses_child", time: { created: now - 4000, updated: now - 900 } },
  { ...base, id: "ses_squadron", title: "Squadron V2 design", directory: "/Users/me/squadron", time: { created: now - 9000, updated: now - 2000 } },
  { ...base, id: "ses_stale", title: "Old standalone", directory: "/Users/me/squadron", time: { created: 1, updated: 2 } },
]
fixture.todos = new Map([["ses_a", [{ content: "Draw the project map", status: "in_progress", priority: "high" }]]])
fixture.mail = (_, recipient) => ({ editspace: "fixture", lane: recipient, messages: [
  { id: "m2", ts: new Date(now - 60_000).toISOString(), from: "home-agents", to: "orchestrator", direction: "sent", deliveries: [], kind: "notice", text: "Map scope report" },
  { id: "m1", ts: new Date(now - 3_600_000).toISOString(), from: "orchestrator", to: "home-agents", direction: "received", deliveries: [], kind: "task", text: "Build the agent map مرحبا" },
] })

const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
await context.route("**/es/api/state?*", async (route) => {
  const response = await route.fetch()
  const body = await response.json()
  body.threads.push({ key: "orchestrator", kind: "ticket", title: "orchestrator", sessions: [], lanes: [remoteLane], tickets: [], prs: [] })
  await route.fulfill({ response, json: body })
})
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const writes = []
page.on("request", (request) => { if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/oc/")) writes.push(`${request.method()} ${request.url()}`) })
const cluster = (name) => page.getByRole("region", { name: `Project ${name}`, exact: true })
const detail = () => page.getByRole("complementary", { name: "Selected agent" })
const mailCalls = () => fixture.calls.filter((call) => call.path === "/api/mail")
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("link", { name: "Agent map", exact: true })).toBeVisible({ timeout: 90_000 })
  await page.getByRole("link", { name: "Agent map", exact: true }).click()
  await expect(page).toHaveURL(/\/map$/)
  await expect(page.getByRole("heading", { name: "Agent map", exact: true })).toBeVisible()

  // A: project topology with typed edges and honest unknowns.
  const lane = cluster("fixture").locator(".map-lane").filter({ hasText: "home-agents" })
  await expect(lane).toContainText("Composer fixture")
  await expect(lane).toContainText("Wiring the agent mapreport")
  await expect(lane.getByRole("list", { name: "Handoff lineage for home-agents" })).toContainText("handed offOther session")
  await expect(lane.getByRole("list", { name: "Subagents" }).first()).toContainText("subagentexplore subagent")
  await expect(lane.locator(".map-node-head .map-dot")).toHaveAttribute("data-status", "busy")
  await expect(cluster("fixture").locator(".map-lane").filter({ hasText: "orchestrator" })).toContainText("ses_remote · not in local session index")
  await expect(cluster("fixture")).toContainText("cloudcloud-reviewprocessing")
  await expect(cluster("squadron")).toContainText("Squadron V2 design")
  await expect(cluster("squadron")).not.toContainText("Old standalone")
  await expect(cluster("squadron")).toContainText("1 more hidden by Active")
  // Handoff predecessors are not duplicated as standalone sessions.
  await expect(cluster("fixture").locator(".map-node").filter({ hasText: "Other session" })).toHaveCount(1)
  await page.getByRole("group", { name: "Map scope" }).getByRole("button", { name: "All", exact: true }).click()
  await expect(cluster("squadron")).toContainText("Old standalone")
  await expect(page).toHaveURL(/show=all/)
  await page.getByRole("group", { name: "Map scope" }).getByRole("button", { name: "Active", exact: true }).click()

  // Selected lane: relations, TODO for the selected owner, and C drill-down of observed mail.
  expect(mailCalls()).toHaveLength(0)
  await lane.locator(".map-node-head").click()
  await expect(detail()).toContainText("ses_a · from lane record")
  await expect(detail()).toContainText("1 verified handoff")
  await expect(detail()).toContainText("Draw the project map")
  await expect(detail().locator(".home-todo")).toContainText("In-progress TODO")
  await detail().getByRole("button", { name: "Load observed mail", exact: true }).click()
  await expect(detail().locator(".map-timeline li")).toHaveCount(2)
  await expect(detail().locator(".map-timeline li").first()).toContainText("Build the agent map")
  await expect(detail().locator(".map-timeline li").first()).toContainText("task")
  expect(mailCalls().map((call) => call.es)).toEqual(["fixture"])
  await page.screenshot({ path: path.join(artifacts, "agent-map-ltr.png"), fullPage: true })
  // Counterpart lane navigation; the new selection does not reuse the prior mail.
  await detail().locator(".map-timeline li").first().getByRole("button", { name: "orchestrator", exact: true }).click()
  await expect(detail()).toContainText("opencode:ses_remote · from lane record")
  await expect(detail()).toContainText("Owner session is not in the local index")
  await expect(detail().getByRole("button", { name: "Load observed mail", exact: true })).toBeVisible()
  expect(mailCalls()).toHaveLength(1)

  // A grandchild rendered in the tree is selectable, and its parent link reaches the child.
  await expect(lane.getByRole("list", { name: "Subagents" }).first()).toContainText("subagentnested reviewer")
  await lane.getByRole("button", { name: /nested reviewer/ }).click()
  await expect(detail()).toContainText("ses_grandchild")
  await detail().getByRole("button", { name: "explore subagent", exact: true }).click()
  await expect(detail()).toContainText("ses_child")
  await expect(detail()).toContainText("1 by session parent")

  // Subagent -> parent resolves to the owner's lane.
  await lane.getByRole("button", { name: /explore subagent/ }).click()
  await expect(detail()).toContainText("ses_child")
  await detail().getByRole("button", { name: "Composer fixture", exact: true }).click()
  await expect(lane).toHaveAttribute("data-selected", "true")

  // Cloud uses its own workflow identity and route.
  await cluster("fixture").getByRole("button", { name: /cloud-review/ }).click()
  await expect(detail()).toContainText("wingman:fixture-task · cloud workflow")
  await expect(detail().getByRole("link", { name: "Open cloud agent", exact: true })).toHaveAttribute("href", "/cloud?es=fixture&lane=cloud-review&owner=wingman%3Afixture-task")
  await expect(detail().getByRole("link", { name: "Open session" })).toHaveCount(0)

  // TODO reads follow the selection lifecycle: with only a cloud agent selected,
  // a reconnect rereads no released session lists.
  const todoCalls = () => fixture.calls.filter((call) => /^\/session\/[^/]+\/todo$/.test(call.path)).length
  const before = todoCalls()
  for (const [response, stream] of fixture.eventStreams) if (stream.path === "/global/event") response.end()
  await page.waitForTimeout(3000)
  expect(todoCalls()).toBe(before)

  // Open the selected lane's session; reload keeps the selection.
  await lane.locator(".map-node-head").click()
  await expect(detail().locator(".home-todo")).toContainText("Draw the project map")
  // Positive control: the live selected watch is reread once on reconnect.
  const watched = todoCalls()
  for (const [response, stream] of fixture.eventStreams) if (stream.path === "/global/event") response.end()
  await expect.poll(todoCalls, { timeout: 10_000 }).toBe(watched + 1)
  const selectedURL = page.url()
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(detail()).toContainText("ses_a · from lane record", { timeout: 30_000 })
  await detail().getByRole("link", { name: "Open session", exact: true }).click()
  await expect(page).toHaveURL(/\/session\/ses_a\?directory=/)
  await page.goto(selectedURL, { waitUntil: "domcontentloaded" })

  // Home project scope applies to the map.
  await page.locator(".es-switcher").selectOption("fixture")
  await expect(cluster("squadron")).toHaveCount(0)
  await expect(cluster("fixture")).toBeVisible()
  await page.locator(".es-switcher").selectOption("__all__")
  await expect(cluster("squadron")).toBeVisible()

  // RTL and mobile.
  await detail().getByRole("button", { name: "Load observed mail", exact: true }).click()
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  expect(await page.locator(".map-arrow").first().evaluate((element) => getComputedStyle(element).transform)).not.toBe("none")
  expect(await lane.evaluate((element) => getComputedStyle(element).borderRightWidth)).toBe("2px")
  await page.screenshot({ path: path.join(artifacts, "agent-map-rtl.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 900 })
  await expect(lane.locator(".map-node-head")).toBeInViewport({ ratio: 0.1 }).catch(async () => { await lane.scrollIntoViewIfNeeded() })
  const box = await detail().boundingBox()
  expect(box.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: path.join(artifacts, "agent-map-mobile-rtl.png"), fullPage: true })
  expect(writes).toEqual([])
  expect(errors).toEqual([])
  console.log(`PASS agent map: topology/handoff/subagent/standalone/cloud, filter/scope, observed mail drill-down, navigation, RTL/mobile, no writes; screenshots in ${artifacts}`)
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, "agent-map-failure.png"), fullPage: true }).catch(() => undefined)
  console.error(error, errors)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close()
}
