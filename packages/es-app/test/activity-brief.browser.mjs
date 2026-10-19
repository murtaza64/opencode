import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.todos = new Map([["ses_a", [{ content: "Verify the current task", status: "in_progress", priority: "high" }]]])
const report = {
  lane: "fixture",
  owner: "ses_a",
  activity: "Checking the reported task",
  activity_at: new Date().toISOString(),
  activity_session: "ses_a",
}
fixture.laneOwners = [report]
fixture.messages[1].parts.push({
  id: "part_todo",
  messageID: "msg_2",
  sessionID: "ses_a",
  type: "tool",
  callID: "call_todo",
  tool: "todowrite",
  state: {
    status: "completed",
    input: { todos: fixture.todos.get("ses_a") },
    output: "Updated",
    title: "Updated TODOs",
    time: { start: Date.now() - 40_000, end: Date.now() - 30_000 },
    metadata: {},
  },
})
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page
  .context()
  .route("**/*", (route) =>
    new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort(),
  )
const strip = page.locator(".session-work-status")
const brief = strip.locator(".activity-brief")
const tool = {
  id: "part_tool",
  messageID: "msg_2",
  sessionID: "ses_a",
  type: "tool",
  callID: "call_tool",
  tool: "bash",
  state: {
    status: "running",
    input: { command: "private-argument-must-not-appear" },
    title: "private-title-must-not-appear",
    time: { start: Date.now() - 20_000 },
    metadata: {},
  },
}
try {
  await page.goto(preview.url)
  await expect(brief).toHaveAttribute("data-source", "reported")
  await expect(brief).toContainText("Checking the reported task")
  report.activity_session = "ses_predecessor"
  fixture.emitDashboard("state")
  await expect(brief).toHaveAttribute("data-source", "todo")
  report.activity_session = "ses_a"
  report.activity_at = new Date(Date.now() - 301_000).toISOString()
  fixture.emitDashboard("state")
  await expect(brief).toHaveAttribute("data-source", "todo")
  await expect(brief).toContainText("Verify the current task")
  await expect(brief).toContainText(/TODO · \d+s ago/)
  const height = (await strip.boundingBox()).height

  fixture.emit("todo.updated", { sessionID: "ses_other", todos: [] })
  await expect(brief).toContainText("Verify the current task")
  fixture.emit("message.part.updated", { part: tool })
  fixture.emit("todo.updated", { sessionID: "ses_a", todos: [] })
  await expect(brief).toHaveAttribute("data-source", "tool")
  await expect(brief.locator(".activity-brief-text")).toHaveText("bash")
  await expect(brief).not.toContainText("private-")
  expect(await brief.getAttribute("title")).not.toContain("private-")
  fixture.emit("message.part.updated", { part: { ...tool, tool: "read" } })
  await expect(brief.locator(".activity-brief-text")).toHaveText("read")
  fixture.emit("message.part.updated", {
    part: {
      ...tool,
      state: {
        ...tool.state,
        status: "completed",
        output: "done",
        time: { start: Date.now() - 20_000, end: Date.now() },
      },
    },
  })
  await expect(brief).toHaveAttribute("data-source", "status")
  await expect(brief).toContainText("Working")

  fixture.emit("todo.updated", {
    sessionID: "ses_a",
    todos: [
      {
        content: `مراجعة src/session.ts 123 — ${"Long mixed text ".repeat(30)}`,
        status: "in_progress",
        priority: "high",
      },
    ],
  })
  await expect(brief).toHaveAttribute("data-source", "todo")
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const dir of ["ltr", "rtl"]) {
      await page.evaluate((dir) => {
        document.documentElement.dir = dir
        document.documentElement.lang = dir === "rtl" ? "ar" : "en"
      }, dir)
      const geometry = await brief.evaluate((element) => {
        const text = element.querySelector(".activity-brief-text")
        return {
          width: element.getBoundingClientRect().width,
          textWidth: text.clientWidth,
          overflow: getComputedStyle(text).textOverflow,
          dir: text.getAttribute("dir"),
          height: element.closest(".session-work-status").getBoundingClientRect().height,
          viewportOverflow: document.documentElement.scrollWidth > innerWidth,
        }
      })
      expect(geometry.width).toBeGreaterThan(0)
      expect(geometry.textWidth).toBeGreaterThan(0)
      expect(geometry.overflow).toBe("ellipsis")
      expect(geometry.dir).toBe("auto")
      expect(geometry.height).toBe(height)
      expect(geometry.viewportOverflow).toBe(false)
    }
  }
  fixture.setStatus("idle")
  await expect(brief).toContainText("Idle")
  expect((await strip.boundingBox()).height).toBe(height)
  fixture.setStatus("busy")
  await expect(brief).toHaveAttribute("data-source", "todo")
  const nextUser = { ...fixture.messages[0].info, id: "msg_3", time: { created: Date.now() } }
  fixture.messages.push({ info: nextUser, parts: [] })
  fixture.emit("message.updated", { info: nextUser })
  await expect(brief).toHaveAttribute("data-source", "status")
  await expect(brief).toContainText("Working")
  fixture.emit("todo.updated", {
    sessionID: "ses_a",
    todos: [{ content: "Task for the new prompt", status: "in_progress", priority: "high" }],
  })
  await expect(brief).toHaveAttribute("data-source", "todo")
  await expect(brief).toContainText("Task for the new prompt")

  expect(fixture.calls.filter((call) => call.generate === "true")).toEqual([])
  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  expect([
    ...new Set(
      fixture.calls.filter((call) => /\/session\/[^/]+\/(todo|message)$/.test(call.path)).map((call) => call.path),
    ),
  ]).toEqual(["/session/ses_a/message", "/session/ses_a/todo"])
  console.log(
    "PASS activity brief: live TODO/tool/status updates; no private tool metadata, generation, writes or fleet reads; bounded LTR/RTL/mobile strip",
  )
} finally {
  await browser.close()
  await preview.close()
}
