import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const fixture = await createFixture()
fixture.status = "idle"
fixture.messages = Array.from({ length: 200 }, (_, turn) => {
  const user = `msg_${String(turn * 2).padStart(6, "0")}`
  const assistant = `msg_${String(turn * 2 + 1).padStart(6, "0")}`
  return [
    {
      info: {
        id: user,
        sessionID: "ses_a",
        role: "user",
        time: { created: turn * 1000 },
        agent: "build",
        model: { providerID: "fixture", modelID: "test" },
      },
      parts: [
        { id: `prt_${user}`, messageID: user, sessionID: "ses_a", type: "text", text: `Synthetic request ${turn}` },
      ],
    },
    {
      info: {
        id: assistant,
        sessionID: "ses_a",
        role: "assistant",
        parentID: user,
        time: { created: turn * 1000 + 1, completed: turn * 1000 + 999 },
        agent: "build",
        mode: "build",
        providerID: "fixture",
        modelID: "test",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [
        ...Array.from({ length: 4 }, (_, index) => ({
          id: `prt_${assistant}_tool_${index}`,
          messageID: assistant,
          sessionID: "ses_a",
          type: "tool",
          callID: `call_${turn}_${index}`,
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "synthetic-check" },
            output: "Synthetic log line: checked fixture item successfully.\n".repeat(100),
            title: "Synthetic check",
            metadata: {},
            time: { start: turn * 1000 + 2, end: turn * 1000 + 3 },
          },
        })),
        ...Array.from({ length: 3 }, (_, index) => ({
          id: `prt_${assistant}_reason_${index}`,
          messageID: assistant,
          sessionID: "ses_a",
          type: "reasoning",
          text:
            `Reasoning ${turn}/${index}.\n\n` +
            "Inspect the synthetic state, compare the expected result, and verify the output before continuing. ".repeat(
              32,
            ),
          time: { start: turn * 1000 + 2, end: turn * 1000 + 3 },
        })),
        {
          id: `prt_${assistant}_1`,
          messageID: assistant,
          sessionID: "ses_a",
          type: "text",
          text: `## Result ${turn}\n\nChecked the synthetic fixture.\n\n\`\`\`ts\nconst result = ${turn}\n\`\`\`\n\n${turn === 199 ? "LATEST-PAINT-SENTINEL" : "Historical result"}`,
          time: { start: turn * 1000 + 4, end: turn * 1000 + 999 },
        },
      ],
    },
  ]
}).flat()
process.env.OPENCODE_URL = fixture.url
process.env.ES_DASHBOARD_URL = fixture.url
const vite = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
})
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const url = `${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
if (process.argv.includes("--serve")) {
  console.log(url)
  await new Promise(() => {})
}
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route("**/*", (route) => {
    const request = new URL(route.request().url())
    return request.origin === origin || ["data:", "blob:"].includes(request.protocol) ? route.continue() : route.abort()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${origin}/session/ses_b?directory=${encodeURIComponent(directory)}`)
  await expect(page.locator(".topbar")).toContainText("Other session")
  for (let attempt = 1; attempt <= 3; attempt++) {
    const profiler = process.env.OPENING_PROFILE && attempt === 1 ? await context.newCDPSession(page) : undefined
    if (profiler) {
      await profiler.send("Profiler.enable")
      await profiler.send("Profiler.start")
    }
    await page.evaluate(() => {
      performance.clearResourceTimings()
      window.opening = { start: performance.now(), longTasks: [] }
      window.opening.observer = new PerformanceObserver((list) =>
        window.opening.longTasks.push(...list.getEntries().map((entry) => entry.duration)),
      )
      window.opening.observer.observe({ type: "longtask" })
      window.opening.mutations = new MutationObserver(() => {
        if (
          window.opening.scheduled ||
          !document
            .querySelector('[data-timeline-part-id="prt_msg_000399_1"]')
            ?.textContent.includes("LATEST-PAINT-SENTINEL")
        )
          return
        window.opening.scheduled = true
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            window.opening.painted = performance.now()
            window.opening.mutations.disconnect()
          }),
        )
      })
      window.opening.mutations.observe(document.body, { childList: true, subtree: true, characterData: true })
      document.querySelector('.sidebar a[href*="/session/ses_a"]').click()
    })
    await page.waitForFunction(() => window.opening.painted)
    await expect(page.locator('[data-timeline-part-id="prt_msg_000399_1"]')).toContainText("LATEST-PAINT-SENTINEL")
    await expect(page.locator(".topbar")).not.toContainText("disconnected")
    const result = await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const end = performance.now()
      window.opening.observer.disconnect()
      const requests = performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/ses_a/message"))
      return {
        // DOM sentinel plus two animation frames; not a compositor paint timestamp.
        latest_frame_ms: Math.round(window.opening.painted - window.opening.start),
        // Includes Playwright polling/assertions and driver round trips.
        check_complete_ms: Math.round(end - window.opening.start),
        messages_requests: requests.length,
        http_ms: requests.map((entry) => Math.round(entry.responseEnd - entry.startTime)),
        long_task_ms: window.opening.longTasks.map(Math.round),
        user_nodes: document.querySelectorAll('[data-component="user-message"]').length,
      }
    })
    console.log(
      JSON.stringify({
        attempt,
        messages: fixture.messages.length,
        bytes: Buffer.byteLength(JSON.stringify(fixture.messages)),
        ...result,
      }),
    )
    expect(result.user_nodes).toBe(200)
    await expect(page.locator('[data-timeline-part-id="prt_msg_000399_1"]')).toBeInViewport()
    await expect(page.locator('[data-component="tool-part-wrapper"][data-tool="bash"]')).toHaveCount(800)
    await expect(page.locator('[data-component="reasoning-part"]')).toHaveCount(600)
    await expect(page.locator('[data-timeline-part-id="prt_msg_000000"]')).toContainText("Synthetic request 0")
    if (profiler) {
      const { profile } = await profiler.send("Profiler.stop")
      const nodes = new Map(profile.nodes.map((node) => [node.id, node.callFrame]))
      const totals = new Map()
      profile.samples.forEach((id, index) => {
        const frame = nodes.get(id)
        const key = `${frame.functionName} ${frame.url.replace(origin, "")}:${frame.lineNumber}`
        totals.set(key, (totals.get(key) ?? 0) + profile.timeDeltas[index] / 1000)
      })
      console.log(JSON.stringify({ profile: [...totals].sort((a, b) => b[1] - a[1]).slice(0, 25) }))
      await profiler.detach()
    }
    if (process.env.OPENING_BUDGET_MS)
      expect(result.latest_frame_ms).toBeLessThan(Number(process.env.OPENING_BUDGET_MS))
    if (attempt === 3) {
      const retained = await page.locator('[data-timeline-part-id="prt_msg_000399_1"]').elementHandle()
      const tool = page.locator('[data-timeline-part-id="prt_msg_000399_tool_3"]')
      const trigger = tool.locator("button[aria-expanded]")
      await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      fixture.disconnect()
      await expect(page.getByRole("alert").filter({ hasText: "Session connection lost" })).toBeVisible()
      fixture.messages.at(-1).parts.at(-1).text += "\n\nREFRESH-SENTINEL"
      fixture.messages.splice(0, 2)
      await page.getByRole("button", { name: "reconnect", exact: true }).click()
      await expect(page.locator('[data-timeline-part-id="prt_msg_000399_1"]')).toContainText("REFRESH-SENTINEL")
      expect(await retained.evaluate((node) => node.isConnected)).toBe(true)
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      await expect(page.locator('[data-component="user-message"]')).toHaveCount(199)
      await expect(page.locator('[data-timeline-part-id="prt_msg_000000"]')).toHaveCount(0)
      await page.setViewportSize({ width: 390, height: 844 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.setViewportSize({ width: 1440, height: 1000 })
    }
    await page.locator('.sidebar a[href*="/session/ses_b"]').first().click()
    await expect(page.locator(".topbar")).toContainText("Other session")
  }
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
} finally {
  await browser.close()
  await vite.close()
  await fixture.close()
}
