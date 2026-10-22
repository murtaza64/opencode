// Agent map from Home in the approved Fleet design (dotfiles#220 A): project
// regions, lanes nested under their delegator/spawner, subagents beneath their
// session, cloud regions, opt-in observed mail for the selected agent (directed
// edges, packets), filters, zoom, motion controls, selection, RTL/mobile. Relations are
// real: lane owner, handoff history, subagent parent, cloud lane record.
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
// Explicit lane provenance: orchestrator's owner delegated home-agents.
fixture.laneProvenance = () => ({ delegations: [{ lane: "home-agents", parent: "ses_remote", session: "ses_a", status: "submitted" }], spawned: [] })
fixture.todos = new Map([["ses_a", [{ content: "Draw the project map", status: "in_progress", priority: "high" }]]])
fixture.mail = (_, recipient) => ({ editspace: "fixture", lane: recipient, messages: [
  { id: "m2", ts: new Date(now - 60_000).toISOString(), from: "home-agents", to: "orchestrator", direction: "sent", deliveries: [], kind: "notice", text: "Map scope report" },
  { id: "m1", ts: new Date(now - 3_600_000).toISOString(), from: "orchestrator", to: "home-agents", direction: "received", deliveries: [], kind: "task", text: "Build the agent map مرحبا" },
  { id: "m3", ts: new Date(now - 30_000).toISOString(), from: "home-agents", to: "project", direction: "sent", deliveries: [], kind: "learning", text: "Broadcast to the project" },
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
// One durable failure (session-failures #232 contract) for a standalone session: the map shares the red state.
await context.route("**/oc/experimental/session/failed", (route) => route.fulfill({ json: [{ sessionID: "ses_squadron", directory: "/Users/me/squadron", messageID: "msg_fail", parentID: "msg_user", time: now - 1000, error: { name: "APIError", statusCode: 403, message: "Forbidden" }, retry: "available" }] }))
const page = await context.newPage()
page.setDefaultTimeout(20_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const writes = []
page.on("request", (request) => { if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/oc/")) writes.push(`${request.method()} ${request.url()}`) })
const region = (name) => page.getByRole("region", { name: `Project ${name}`, exact: true })
const node = (name) => page.locator(".map-node-box").filter({ has: page.locator(".map-node-name bdi", { hasText: new RegExp(`^${name}$`) }) })
const detail = () => page.getByRole("complementary", { name: "Selected agent" })
const mailCalls = () => fixture.calls.filter((call) => call.path === "/api/mail")
const edge = (from, to) => page.locator(`.map-mail-edge[data-from='${JSON.stringify(["lane", "fixture", from])}'][data-to='${JSON.stringify(["lane", "fixture", to])}']`)
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 90_000 })
  await expect(page.getByRole("link", { name: "Agent map", exact: true })).toBeVisible({ timeout: 90_000 })
  await page.getByRole("link", { name: "Agent map", exact: true }).click()
  await expect(page).toHaveURL(/\/map$/)
  await expect(page.getByRole("heading", { name: "Agent map", exact: true })).toBeVisible()

  // A · Project map: an SVG network with boxed project regions and agent nodes.
  await expect(page.getByRole("heading", { name: "Project map", exact: true })).toBeVisible()
  await expect(page.locator(".map-canvas svg[aria-label='Agent network']")).toBeVisible()
  await expect(page.locator(".map-cluster-box")).toHaveCount(3)
  await expect(region("fixture").locator(".map-cluster-title")).toHaveText("FIXTURE · 4 AGENTS")
  // Cloud agents get their own region.
  await expect(region("fixture cloud").locator(".map-cluster-title")).toHaveText("FIXTURE · CLOUD · 1 AGENT")
  await expect(region("fixture cloud").locator(".map-node-box")).toHaveCount(1)
  const lane = node("home-agents")
  await expect(lane).toHaveAttribute("data-tone", "working")
  await expect(lane).toContainText("working")
  await expect(lane.locator(".map-runtime")).toHaveText("L")
  await expect(lane.locator(".map-handoffs")).toHaveText("↺1")
  await expect(node("orchestrator")).toHaveAttribute("data-tone", "unknown")
  await expect(node("cloud-review")).toContainText("processing")
  await expect(node("cloud-review").locator(".map-runtime")).toHaveText("W")
  await expect(region("squadron").locator(".map-node-box")).toHaveCount(1)
  await expect(node("Squadron V2 design")).toHaveAttribute("data-tone", "failed")
  // Subagents sit below their parent, joined by dashed hierarchy edges (not mail).
  await expect(node("explore subagent")).toHaveAttribute("data-kind", "subagent")
  await expect(node("nested reviewer")).toBeVisible()
  await expect(page.locator(".map-hierarchy[data-kind=subagent]")).toHaveCount(2)
  expect((await node("explore subagent").boundingBox()).y).toBeGreaterThan((await lane.boundingBox()).y)
  // The delegated lane sits beneath its delegator with a solid org edge.
  expect((await lane.boundingBox()).y).toBeGreaterThan((await node("orchestrator").boundingBox()).y)
  await expect(page.locator(".map-hierarchy[data-kind=delegated]")).toHaveCount(1)
  expect(await page.locator(".map-hierarchy[data-kind=delegated]").getAttribute("marker-end")).toBe("url(#map-org-arrow)")
  expect(fixture.calls.filter((call) => call.path === "/api/lane-provenance").map((call) => call.es)).toContain("fixture")
  // Handoff predecessors are not duplicated as map nodes.
  await expect(node("Other session")).toHaveCount(0)
  await expect(page.locator(".map-summary")).toContainText("1 hidden (idle over 24h, unpinned)")
  await expect(node("Old standalone")).toHaveCount(0)
  await page.getByRole("combobox", { name: "Agents" }).selectOption("all")
  await expect(node("Old standalone")).toBeVisible()
  await expect(page).toHaveURL(/agents=all/)
  await page.getByRole("combobox", { name: "Agents" }).selectOption("active")
  await expect(node("Old standalone")).toHaveCount(0)
  await expect(page.locator(".map-legend")).toContainText("solid → = delegated / spawned lane (long dash: by a past owner) · dashed = subagent")
  await expect(page.getByRole("region", { name: "State boundaries" })).toContainText("Turn failed")
  await expect(page.getByRole("region", { name: "State boundaries" })).toContainText("Wiring the agent map")

  // Topology is the default: selecting reads no mail and draws no mail edges.
  await lane.click()
  await expect(lane).toHaveAttribute("aria-pressed", "true")
  await expect(detail()).toContainText("ses_a · from lane record")
  await expect(page.locator(".map-mail-edge")).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Directed mail" })).toHaveCount(0)
  expect(mailCalls()).toHaveLength(0)
  // Opt-in mail draws only the selected agent's observed mail as directed edges.
  await page.getByRole("checkbox", { name: "Mail for selected agent" }).check()
  await expect(edge("orchestrator", "home-agents")).toHaveCount(1)
  await expect(edge("home-agents", "orchestrator")).toHaveCount(1)
  expect(await edge("home-agents", "orchestrator").locator("path").first().getAttribute("marker-end")).toBe("url(#map-arrow)")
  await expect(edge("home-agents", "orchestrator").locator(".map-packet")).toHaveCount(1)
  // An off-map counterpart is listed but not drawn on the map.
  await expect(page.locator(".map-mail-edge")).toHaveCount(2)
  expect(mailCalls().map((call) => call.es)).toEqual(["fixture"])
  await expect(page.locator(".map-mail-row")).toHaveCount(3)
  await expect(detail()).toContainText("Broadcast to the project")
  await expect(detail()).toContainText("Observed record. Not proof of delivery or execution.")
  await edge("orchestrator", "home-agents").locator(".map-edge-hit").dispatchEvent("click")
  await expect(detail().locator(".map-message")).toContainText("Build the agent map")
  await expect(edge("orchestrator", "home-agents")).toHaveClass(/emphasized/)
  await expect(detail()).toContainText("ses_a · from lane record")
  await expect(detail()).toContainText("1 verified handoff")
  await expect(detail()).toContainText("orchestrator · delegation (submitted)")
  await expect(detail()).toContainText("Composer fixture · ses_a")
  await expect(detail().locator(".home-todo")).toContainText("Draw the project map")
  await page.screenshot({ path: path.join(artifacts, "agent-map-ltr.png"), fullPage: true })

  // Filters: Events and Runtime.
  await page.getByRole("combobox", { name: "Events" }).selectOption("major")
  await expect(page.getByRole("region", { name: "State boundaries" })).not.toContainText("Wiring the agent map")
  await expect(page.getByRole("region", { name: "State boundaries" })).toContainText("Turn failed")
  await page.getByRole("combobox", { name: "Events" }).selectOption("all")
  await page.getByRole("combobox", { name: "Runtime" }).selectOption("cloud")
  await expect(page.locator(".map-node-box")).toHaveCount(1)
  await expect(detail()).toContainText("Selected agent is outside the current filter.")
  await page.getByRole("combobox", { name: "Runtime" }).selectOption("all")

  // Zoom.
  const width = async () => Number(await page.locator(".map-canvas svg").getAttribute("width"))
  const fitted = await width()
  await page.getByRole("button", { name: "Zoom in", exact: true }).click()
  expect(await width()).toBeGreaterThan(fitted)
  await expect(page.locator(".map-zoom output")).toHaveText(/^\d+%$/)
  await page.getByRole("button", { name: "Fit", exact: true }).click()
  expect(await width()).toBe(fitted)

  // Motion: pause and manual reduce keep the network static.
  await expect(page.locator(".agent-map-page")).toHaveAttribute("data-still", "false")
  await page.getByRole("button", { name: "Pause motion", exact: true }).click()
  await expect(page.locator(".agent-map-page")).toHaveAttribute("data-still", "true")
  expect(await page.locator(".map-packet").first().evaluate((element) => getComputedStyle(element).animationPlayState)).toBe("paused")
  await page.getByRole("button", { name: "Resume motion", exact: true }).click()
  await page.getByRole("checkbox", { name: "Reduce motion" }).check()
  await expect(page.locator(".agent-map-page")).toHaveAttribute("data-still", "true")
  await page.getByRole("checkbox", { name: "Reduce motion" }).uncheck()

  // The Time weave is gone; an old ?view=weave link resolves to the Project map.
  await expect(page.getByRole("button", { name: "Time weave" })).toHaveCount(0)
  await page.goto(`${preview.url}/map?view=weave&select=${encodeURIComponent(JSON.stringify(["lane", "fixture", "home-agents"]))}`, { waitUntil: "domcontentloaded", timeout: 90_000 })
  await expect(page.getByRole("heading", { name: "Project map", exact: true })).toBeVisible({ timeout: 90_000 })
  await expect(page.locator(".map-time-agents, .map-time-network")).toHaveCount(0)
  await page.getByRole("checkbox", { name: "Mail for selected agent" }).check()
  await expect(edge("home-agents", "orchestrator")).toHaveCount(1)
  // The page load is fresh, so its one read for the selected lane is the second overall.
  await expect.poll(() => mailCalls().length).toBe(2)

  // Counterpart navigation; mail for the new selection accumulates without duplicate edges.
  await page.locator(".map-mail-row").filter({ hasText: "Map scope report" }).getByRole("button", { name: "orchestrator", exact: true }).click()
  await expect(detail()).toContainText("opencode:ses_remote · from lane record")
  await expect(detail()).toContainText("Owner session is not in the local index")
  await expect.poll(() => mailCalls().length).toBe(3)
  await expect(page.locator(".map-mail-edge")).toHaveCount(2)
  // Reselecting an agent does not reread its mail.
  await lane.click()
  await node("orchestrator").click()
  expect(mailCalls()).toHaveLength(3)

  // A grandchild node is selectable, and its parent link reaches the child.
  await node("nested reviewer").click()
  await expect(detail()).toContainText("ses_grandchild")
  await detail().getByRole("button", { name: "explore subagent", exact: true }).click()
  await expect(detail()).toContainText("ses_child")
  await expect(detail()).toContainText("1 by session parent")
  // Subagent -> parent resolves to the owner's lane.
  await detail().getByRole("button", { name: "Composer fixture", exact: true }).click()
  await expect(lane).toHaveAttribute("aria-pressed", "true")
  // A handoff predecessor is selectable from the lineage.
  await detail().getByRole("list", { name: "Handoff lineage for home-agents" }).getByRole("button", { name: "Other session", exact: true }).click()
  await expect(detail()).toContainText("ses_b")

  // Cloud uses its own workflow identity and route, and has no mail source.
  await node("cloud-review").click()
  await expect(detail()).toContainText("wingman:fixture-task · cloud workflow")
  await expect(detail().getByRole("link", { name: "Open cloud agent", exact: true })).toHaveAttribute("href", "/cloud?es=fixture&lane=cloud-review&owner=wingman%3Afixture-task")
  await expect(detail().getByRole("link", { name: "Open session" })).toHaveCount(0)
  await expect(detail()).toContainText("No mail source for this agent.")

  // TODO reads follow the selection lifecycle: with only a cloud agent selected,
  // a reconnect rereads no released session lists.
  const todoCalls = () => fixture.calls.filter((call) => /^\/session\/[^/]+\/todo$/.test(call.path)).length
  const before = todoCalls()
  for (const [response, stream] of fixture.eventStreams) if (stream.path === "/global/event") response.end()
  await page.waitForTimeout(3000)
  expect(todoCalls()).toBe(before)
  await lane.click()
  await expect(detail().locator(".home-todo")).toContainText("Draw the project map")
  // Positive control: the live selected watch is reread once on reconnect.
  const watched = todoCalls()
  for (const [response, stream] of fixture.eventStreams) if (stream.path === "/global/event") response.end()
  await expect.poll(todoCalls, { timeout: 10_000 }).toBe(watched + 1)

  // Reload keeps the selection; open the selected session.
  const selectedURL = page.url()
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 })
  await expect(detail()).toContainText("ses_a · from lane record", { timeout: 30_000 })
  await detail().getByRole("link", { name: "Open session", exact: true }).click()
  await expect(page).toHaveURL(/\/session\/ses_a\?directory=/)
  await page.goto(selectedURL, { waitUntil: "domcontentloaded", timeout: 90_000 })

  // Home project scope applies to the map.
  await page.locator(".es-switcher").selectOption("fixture")
  await expect(region("squadron")).toHaveCount(0)
  await expect(region("fixture")).toBeVisible()
  await page.locator(".es-switcher").selectOption("__all__")
  await expect(region("squadron")).toBeVisible()

  // RTL: controls and detail mirror; graph geometry and time stay physical LTR.
  await page.getByRole("checkbox", { name: "Mail for selected agent" }).check()
  await expect(edge("home-agents", "orchestrator")).toHaveCount(1)
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  expect(await page.locator(".map-canvas").evaluate((element) => getComputedStyle(element).direction)).toBe("ltr")
  await expect(page.locator(".map-node-host").first()).toHaveAttribute("dir", "rtl")
  expect(await page.locator(".map-arrow").first().evaluate((element) => getComputedStyle(element).transform)).not.toBe("none")
  expect((await detail().boundingBox()).x).toBeLessThan((await page.locator(".map-main").boundingBox()).x)
  await page.screenshot({ path: path.join(artifacts, "agent-map-rtl.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 900 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  expect((await detail().boundingBox()).width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: path.join(artifacts, "agent-map-mobile-rtl.png"), fullPage: true })

  // OS reduced motion keeps the replay static without a manual toggle.
  const reduced = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })
  await reduced.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const still = await reduced.newPage()
  await still.goto(`${preview.url}/map`, { waitUntil: "domcontentloaded", timeout: 90_000 })
  await expect(still.locator(".agent-map-page")).toHaveAttribute("data-still", "true", { timeout: 90_000 })
  await expect(still.locator(".map-motion")).toContainText("OS reduced motion · static")
  await reduced.close()

  expect(writes).toEqual([])
  expect(errors).toEqual([])
  console.log(`PASS agent map: A network (project/cloud regions, delegated lane under delegator, spawned subagents, opt-in selected-agent mail edges/packets, zoom), filters, motion/OS reduced, selection/navigation/TODO lifecycle, scope, RTL/mobile, no writes; screenshots in ${artifacts}`)
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, "agent-map-failure.png"), fullPage: true }).catch(() => undefined)
  console.error(error, errors)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close()
}
