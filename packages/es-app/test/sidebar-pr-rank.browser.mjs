/* Ranked, enriched PR chips (dotfiles#140): cited PRs sorted by mention count
 * with stable ties, dashboard-only PRs last, minimal chips immediately and
 * incremental enrichment through /api/pr-detail with bounded concurrency,
 * no invented status, cache across reloads, endpoint-missing backoff. */
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const url = (n) => `https://github.com/example/repo/pull/${n}`
// #3 cited in 3 parts (one part repeats it: still one mention), #2 in 2, #1 once, #9 once later (tie -> first mention), 30 more once each
fixture.messages[1].parts[0].text = `${url(1)} ${url(3)} ${url(3)} ${url(2)}\n${Array.from({ length: 30 }, (_, i) => url(100 + i)).join(" ")} https://github.com/fork/repo/pull/5`
fixture.messages[1].parts.push(
  { id: "t1", messageID: "msg_2", sessionID: "ses_a", type: "tool", tool: "read", callID: "r1",
    state: { status: "completed", input: {}, output: `${url(3)} and https://duo.fyi/ink/${url(2)}`, title: "Read", time: { start: 1, end: 2 } } },
  { id: "t2", messageID: "msg_2", sessionID: "ses_a", type: "tool", tool: "read", callID: "r2",
    state: { status: "completed", input: {}, output: `${url(3)}/files ${url(9)}`, title: "Read", time: { start: 1, end: 2 } } },
  { id: "t3", messageID: "msg_2", sessionID: "ses_a", type: "tool", tool: "read", callID: "r3",
    state: { status: "running", input: {}, output: url(777), title: "Read", time: { start: 1 } } },
)
const state = await (await fetch(`${fixture.url}/api/state`)).json()
state.threads[0].prs = [
  { repo: "example/repo", number: 2, url: url(2), title: "Dashboard PR", state: "open", isDraft: false, ci: "passing", ci_failing: 0, ci_pending: 0, reviews: [{ login: "alice", state: "APPROVED" }], review_requested: [] },
  { repo: "example/repo", number: 50, url: url(50), title: "Dashboard only", state: "merged" },
]
let maxInflight = 0
let inflight = 0
const detailCalls = () => fixture.calls.filter((c) => c.path === "/api/pr-detail").map((c) => c)
const detail = {
  3: { number: 3, title: "Enriched #3", url: url(3), repo: "example/repo", state: "open", isDraft: false, ci: "failing", ci_failing: 2, ci_pending: 1, reviews: [{ login: "bob", state: "CHANGES_REQUESTED" }], review_requested: ["carol"], additions: 12, deletions: 4 },
  1: { number: 1, title: "Closed #1", url: url(1), repo: "example/repo", state: "closed", ci: "none", reviews: [], review_requested: [] },
  9: { status: 502, body: { error: "PR detail unavailable" } },
}
fixture.prDetails = (href) => {
  const n = Number(href.split("/").pop())
  return detail[n]
}
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
await page.route("**/api/state*", route => route.fulfill({ json: state }))
await page.route("**/api/pr-detail*", async (route) => {
  inflight++
  maxInflight = Math.max(maxInflight, inflight)
  await new Promise((r) => setTimeout(r, 120))
  inflight--
  await route.continue()
})
const chips = page.locator(".session-info [data-section='prs'] .pr-title-row")
try {
  await page.goto(preview.url)
  await expect(chips).toHaveCount(36)
  // a second owner with the same repo name forces full labels for both
  await expect(chips.filter({ hasText: "fork/repo#5" })).toHaveCount(1)
  await expect(chips.nth(0).locator(".pr-number")).toHaveText("example/repo#3")
  // order: #3 (3 mentions), #2 (2), #1, #9? no: #1 then the 30 at one each then #9? first-mention order: #1 precedes 100.. precedes #9
  await expect(chips.nth(0)).toHaveAttribute("href", `https://duo.fyi/ink/${url(3)}`)
  await expect(chips.nth(0)).toHaveAttribute("data-mentions", "3")
  await expect(chips.nth(0).locator(".pr-mentions")).toHaveText("×3")
  await expect(chips.nth(1)).toHaveAttribute("href", `https://duo.fyi/ink/${url(2)}`)
  await expect(chips.nth(1)).toHaveAttribute("data-mentions", "2")
  await expect(chips.nth(2)).toHaveAttribute("href", `https://duo.fyi/ink/${url(1)}`)
  await expect(chips.nth(2).locator(".pr-mentions")).toHaveCount(0)
  await expect(chips.nth(3)).toHaveAttribute("href", `https://duo.fyi/ink/${url(100)}`)
  await expect(chips.nth(34)).toHaveAttribute("href", `https://duo.fyi/ink/${url(9)}`)
  await expect(chips.nth(35)).toHaveAttribute("href", `https://duo.fyi/ink/${url(50)}`)
  await expect(chips.nth(35).locator(".icon-merged")).toHaveCount(1)
  await expect(chips.nth(35)).not.toHaveAttribute("data-mentions")
  await expect(page.locator(".session-info .pr-title-row[href*='/777']")).toHaveCount(0)
  await expect(chips.nth(3).locator(".pr-number")).toHaveText("example/repo#100")
  // dashboard data wins for #2 immediately: approved + passing
  await expect(chips.nth(1).locator(".approved-icon")).toHaveCount(1)
  await expect(chips.nth(1).locator(".ci-passing")).toHaveCount(1)
  // enrichment lands: #3 shows failing CI + changes requested + pending reviewer, #1 closed, #9 stays unresolved
  await expect(chips.nth(0).locator(".ci-failing")).toHaveCount(1)
  await expect(chips.nth(0).locator(".changes-requested")).toContainText("bob")
  await expect(chips.nth(0).locator(".pending-reviews")).toContainText("carol")
  await expect(chips.nth(0).locator(".pr-diff-stats")).toContainText("+12")
  await expect(chips.nth(0)).toHaveAttribute("data-pr-state", "open")
  await expect(chips.nth(2).locator(".icon-closed")).toHaveCount(1)
  await expect(chips.nth(2).locator(".ci-symbol-group")).toHaveCount(0)
  await expect(chips.nth(34)).toHaveAttribute("data-pr-state", "unknown")
  await expect(chips.nth(34).locator(".pr-state-placeholder")).toHaveCount(1)
  await expect(chips.nth(34).locator(".pr-metadata-badge")).toHaveCount(0)
  await expect(chips.nth(3)).toHaveAttribute("data-pr-state", "unknown")
  await expect.poll(() => detailCalls().length).toBe(30) // top-30 cited without dashboard data; #2 and #50 not requested
  expect(maxInflight).toBeLessThanOrEqual(3)
  await page.waitForTimeout(300)
  expect(detailCalls().length).toBe(30) // no re-requests on re-render, failed #9 not retried immediately
  // reload within TTL: chips re-render immediately and enrichment is requested again (fresh page memory), still bounded
  fixture.calls.length = 0
  await page.reload()
  await expect(chips).toHaveCount(36)
  await expect(chips.nth(0).locator(".ci-failing")).toHaveCount(1)
  await expect.poll(() => detailCalls().length).toBe(30)
  // live mention bump reorders: #9 cited again twice -> moves above the single mentions
  const info = { ...fixture.messages[0].info, id: "msg_9_live", sessionID: "ses_a" }
  const part = { ...fixture.messages[0].parts[0], id: "live_part", messageID: info.id, text: `${url(9)} more` }
  fixture.messages.push({ info, parts: [part] })
  fixture.emit("message.updated", { info })
  fixture.emit("message.part.updated", { part })
  // ties with #2 (2 mentions); #2 was mentioned first so it stays ahead
  await expect(chips.nth(1)).toHaveAttribute("href", `https://duo.fyi/ink/${url(2)}`)
  await expect(chips.nth(2)).toHaveAttribute("href", `https://duo.fyi/ink/${url(9)}`)
  await expect(chips.nth(2)).toHaveAttribute("data-mentions", "2")
  await expect(chips.nth(3)).toHaveAttribute("href", `https://duo.fyi/ink/${url(1)}`)
  // endpoint missing: minimal chips, one probe, then silence
  fixture.prDetails = undefined
  fixture.calls.length = 0
  await page.reload()
  await expect(chips).toHaveCount(36)
  await expect(chips.nth(0)).toHaveAttribute("data-pr-state", "unknown")
  await expect(chips.nth(1).locator(".ci-passing")).toHaveCount(1)
  await page.waitForTimeout(600)
  expect(detailCalls().length).toBeLessThanOrEqual(3)
  expect(fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log("PASS sidebar PR rank browser: mention order/ties, dashboard-only last, immediate minimal chips, bounded enrichment (<=3 inflight, top 30), unresolved stays unknown, 502 not invented, reload, live reorder, missing endpoint backoff; zero mutations")
} finally {
  await browser.close()
  await preview.close()
}
