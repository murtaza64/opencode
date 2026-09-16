// Run against the existing Vite server; every backend request is intercepted.
import { strict as assert } from "node:assert"
const { chromium, expect } = await import(process.env.PLAYWRIGHT_MODULE ?? "@playwright/test")

const browser = await chromium.launch({ headless: true, channel: "chrome" })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const pr = "https://github.com/duolingo/infra-core/pull/10265"
const session = (id) => ({
  id,
  title: id === "next" ? "Other session infra-core#10265" : id,
  directory: "/fixture/api-testing",
  projectID: "fixture",
  version: "1",
  time: { created: 1, updated: 2 },
})
let enriched = false
const messages = (id) =>
  (id === "next"
    ? ["infra-core#10265"]
    : [
        `[Canonical PR](${pr})`,
        `[Repeated PR](https://duo.fyi/ink/${pr}#discussion_r1)`,
        "Later infra-core#10265",
        "[First owner](https://github.com/first/shared/pull/7) and [second owner](https://github.com/second/shared/pull/7)",
        "Ambiguous shared#7; qualified first/shared#7",
        `[infra-core#10265](https://github.com/duolingo/infra-core/issues/10265)`,
      ]
  ).map((text, index) => ({
    info: {
      id: `msg_${index}`,
      sessionID: id,
      role: "assistant",
      parentID: "msg_user",
      time: { created: index + 1, completed: index + 2 },
      agent: "build",
      mode: "build",
      modelID: "fixture",
      providerID: "fixture",
      path: { cwd: "/fixture", root: "/fixture" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: [{ id: `prt_${index}`, messageID: `msg_${index}`, sessionID: id, type: "text", text }],
  }))

await page.addInitScript(() => {
  localStorage.setItem("es-app-editspace", "defaultdotfiles")
  localStorage.setItem("es-app-all-projects", "true")
})
await page.route(/\/(es|oc)\//, async (route) => {
  const url = new URL(route.request().url())
  assert.equal(route.request().method(), "GET", "Fixture must not mutate backend state")
  if (/events?$/.test(url.pathname)) {
    return route.fulfill({ contentType: "text/event-stream", body: ": connected\n\n" })
  }
  const data = (() => {
    if (url.pathname === "/es/api/state")
      return {
        editspace: "defaultdotfiles",
        root: "/fixture/dotfiles",
        generated_at: 1,
        threads: [],
        attention: [],
        frontier: [],
        sessions: [],
        unattached_prs: enriched
          ? [{ repo: "duolingo/infra-core", number: 10265, url: pr, title: "Enriched PR", state: "open" }]
          : [],
      }
    if (url.pathname === "/es/api/editspaces")
      return {
        editspaces: [{ name: "defaultdotfiles", root: "/fixture/dotfiles" }],
        default: "defaultdotfiles",
      }
    if (url.pathname === "/es/api/notifications") return { notifications: [] }
    if (url.pathname === "/es/api/issues") return { backend: "gh", repo: "murtaza64/dotfiles", issues: [] }
    if (url.pathname === "/es/api/docs") return { roots: [], sources: [] }
    if (url.pathname.endsWith("/message")) return messages(url.pathname.split("/").at(-2))
    if (url.pathname === "/oc/session/status") return {}
    if (url.pathname === "/oc/config/providers") return { providers: [] }
    if (url.pathname === "/oc/session" || url.pathname === "/oc/experimental/session")
      return [session("active"), session("next")]
    if (/^\/oc\/session\/[^/]+$/.test(url.pathname)) return session(url.pathname.split("/").at(-1))
    return []
  })()
  return route.fulfill({ json: data })
})

const bare = () => page.locator('.transcript .ticket-ref[data-ticket="infra-core#10265"]').first()
const tipLink = () => page.locator(".ticket-tip a")
try {
  await page.goto(
    `${process.env.SITE_URL ?? "http://127.0.0.1:3100"}/session/active?directory=%2Ffixture%2Fapi-testing`,
  )
  await expect(page.locator('.transcript a[href*="/pull/10265"]')).toHaveCount(2)
  await bare().hover()
  await expect(tipLink()).toHaveText(/open PR/)
  await expect(tipLink()).toHaveAttribute("href", `https://duo.fyi/ink/${pr}`)
  await page.locator(".es-switcher").selectOption("defaultdotfiles")
  await bare().hover()
  await expect(tipLink()).toHaveAttribute("href", `https://duo.fyi/ink/${pr}`)
  await page.locator(".es-switcher").selectOption("__all__")
  console.log("PASS: unrelated selected project and All, repeated transcript PR URLs and later bare ref")

  await page.locator('.transcript .ticket-ref[data-ticket="shared#7"]').hover()
  await expect(tipLink()).toHaveAttribute("href", "/issue?ref=shared%237")
  await page.locator('.transcript .ticket-ref[data-ticket="first/shared#7"]').hover()
  await expect(tipLink()).toHaveAttribute("href", "https://duo.fyi/ink/https://github.com/first/shared/pull/7")
  console.log("PASS: ambiguous short repo rejected; fully qualified reference resolves")

  await page.locator('.transcript a[href*="/issues/10265"] .ticket-ref').hover()
  await expect(tipLink()).toHaveAttribute(
    "href",
    "https://duo.fyi/ink/https://github.com/duolingo/infra-core/issues/10265",
  )
  console.log("PASS: explicit issue URL overrides known PR")

  const next = page.locator('a[href*="/session/next"]').first()
  await next.locator(".ticket-ref").hover()
  await expect(tipLink()).toHaveAttribute("href", "/issue?ref=infra-core%2310265")
  await next.click()
  await expect(page).toHaveURL(/\/session\/next\?/)
  await expect(page.locator('.transcript a[href*="/pull/"]')).toHaveCount(0)
  await bare().hover()
  await expect(tipLink()).toHaveAttribute("href", "/issue?ref=infra-core%2310265")
  console.log("PASS: sidebar session title isolated; navigation discards previous transcript candidates")

  enriched = true
  await page.goto(
    `${process.env.SITE_URL ?? "http://127.0.0.1:3100"}/session/active?directory=%2Ffixture%2Fapi-testing`,
  )
  await expect(page.locator('.transcript a[href*="/pull/10265"]')).toHaveCount(2)
  await bare().hover()
  await expect(page.locator(".ticket-tip .tip-title")).toHaveText("Enriched PR")
  await expect(tipLink()).toHaveAttribute("href", `https://duo.fyi/ink/${pr}`)
  assert.deepEqual(errors, [])
  console.log("PASS: canonical dashboard metadata retained; no browser errors")
} finally {
  await browser.close()
}
