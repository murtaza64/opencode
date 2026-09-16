import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"
import { tmpdir } from "./fixture/fixture"

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("real App Tab commands route only Queue to its saved agent and leave active modes read-only", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ animations_enabled: false }))
  const setup = await createTestRenderer({ width: 100, height: 32, useThread: false, kittyKeyboard: true })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const session = {
    id: "ses_agent",
    projectID: "proj_test",
    directory: tmp.path,
    agent: "build",
    title: "Agent routing",
    slug: "agent-routing",
    version: "1",
    time: { created: 0, updated: 0 },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/project/proj_test/directories") return json([{ directory: tmp.path }])
    if (url.pathname === "/path")
      return json({ home: tmp.path, state: tmp.path, config: tmp.path, worktree: tmp.path, directory: tmp.path })
    if (url.pathname === "/session") return json([session])
    if (url.pathname === "/session/ses_agent") return json(session)
    if (url.pathname === "/session/status") return json({ ses_agent: { type: "busy" } })
    if (/\/session\/ses_agent\/(message|todo|diff)$/.test(url.pathname)) return json([])
    if (url.pathname === "/session/ses_agent/input") return json({ items: [], next: null })
    if (url.pathname === "/agent")
      return json([
        { name: "build", mode: "primary", options: {}, permission: [] },
        { name: "plan", mode: "primary", options: {}, permission: [] },
      ])
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", models: { model: { id: "model", name: "Test model" } } }],
        default: { test: "model" },
      })
    if (url.pathname === "/experimental/capabilities")
      return json({
        sessionAside: { version: 1, cancel: true },
        sessionInput: { version: 1, delivery: ["queue", "steer"], list: true, cancel: true },
      })
  })
  const admitted: { requestID: string; delivery: string; text: string; agent?: string }[] = []
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (request.method === "GET") return calls.fetch(request)
    if (new URL(request.url).pathname !== "/session/ses_agent/input") throw new Error("Unexpected mutation")
    const body = await request.json()
    admitted.push(body)
    return json({ ...body, state: "pending" })
  }) as typeof fetch
  let api: TuiPluginApi | undefined
  let disposeSlots: (() => void) | undefined
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      url: "http://test",
      directory: tmp.path,
      fetch: transport,
      events: events.source,
      args: { sessionID: "ses_agent" },
      config: createTuiResolvedConfig({ plugin_enabled: {} }),
      pluginHost: {
        async start(input) {
          api = input.api
          disposeSlots = input.runtime.setupSlots(input.api).dispose
        },
        async dispose() {
          disposeSlots?.()
        },
      },
    }).pipe(
      Effect.provide(
        Global.layerWith({
          home: tmp.path,
          data: tmp.path,
          cache: tmp.path,
          config: tmp.path,
          state: tmp.path,
          tmp: tmp.path,
          bin: tmp.path,
          log: tmp.path,
          repos: tmp.path,
        }),
      ),
    ),
  )
  const waitFrame = async (text: string) => {
    const start = Date.now()
    while (true) {
      await setup.renderOnce()
      if (setup.captureCharFrame().includes(text)) return
      if (Date.now() - start > 3000) throw new Error(`Missing ${text}\n${setup.captureCharFrame()}`)
      await Bun.sleep(10)
    }
  }
  try {
    await waitFrame("Build > Aside [Queue]")
    setup.mockInput.pressTab()
    await waitFrame("Plan > Aside [Queue]")
    await setup.mockInput.typeText("/agents")
    await waitFrame("Switch agent")
    setup.mockInput.pressTab()
    await waitFrame("Queue agent")
    setup.mockInput.pressEscape()
    await waitFrame("Plan > Aside [Queue]")
    await setup.mockInput.typeText("Queue with Plan")
    setup.mockInput.pressEnter()
    await waitFrame("Input pending")
    expect(admitted).toEqual([
      { requestID: expect.any(String), delivery: "queue", text: "Queue with Plan", agent: "plan" },
    ])
    events.emit({
      directory: tmp.path,
      payload: {
        id: "evt_permission",
        type: "permission.asked",
        properties: {
          id: "per_keyboard",
          sessionID: "ses_agent",
          permission: "bash",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        },
      },
    })
    await waitFrame("Review human request")
    setup.mockInput.pressKey("g", { meta: true })
    await waitFrame("Permission required")
    setup.mockInput.pressTab()
    setup.mockInput.pressKey("x", { ctrl: true })
    setup.mockInput.pressKey("a")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("Queue agent")
    setup.mockInput.pressKey("g", { meta: true })
    await waitFrame("Plan > Aside [Queue]")
    events.emit({
      directory: tmp.path,
      payload: {
        id: "evt_permission_replied",
        type: "permission.replied",
        properties: {
          sessionID: "ses_agent",
          requestID: "per_keyboard",
          reply: "once",
        },
      },
    })
    setup.mockInput.pressKey("m", { meta: true })
    await waitFrame("Build active Aside Queue [Steer]")
    setup.mockInput.pressTab()
    await waitFrame("Build active Aside Queue [Steer]")
    setup.mockInput.pressKey("m", { meta: true })
    await waitFrame("Build active [Aside]")
    setup.mockInput.pressTab({ shift: true })
    setup.mockInput.pressKey("x", { ctrl: true })
    setup.mockInput.pressKey("a")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("Select agent")
    expect(setup.captureCharFrame()).not.toContain("Queue agent")
    setup.mockInput.pressKey("m", { meta: true })
    await waitFrame("Plan > Aside [Queue]")
    setup.mockInput.pressTab({ shift: true })
    await waitFrame("Build > Aside [Queue]")
    setup.mockInput.pressTab()
    await waitFrame("Plan > Aside [Queue]")
    events.emit({
      directory: tmp.path,
      payload: {
        id: "evt_idle",
        type: "session.status",
        properties: { sessionID: "ses_agent", status: { type: "idle" } },
      },
    })
    await waitFrame("Send")
    const send = setup.renderer.root.findDescendantById("composer-send")!
    await setup.mockMouse.click(send.x + 1, send.y)
    await waitFrame("Build >")
    setup.mockInput.pressTab()
    await waitFrame("Plan >")
    expect(admitted).toHaveLength(1)
  } finally {
    api?.keymap.dispatchCommand("app.exit")
    await task
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "Demo session",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("fatal startup errors set a nonzero exit after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  await mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/config")
      return json(
        {
          name: "ConfigRemoteAuthError",
          data: {
            url: "https://example.com",
            remote: "https://config.example.com/opencode.json",
          },
        },
        { status: 400 },
      )
    return undefined
  })
  let disposes = 0
  const originalWrite = process.stderr.write.bind(process.stderr)
  const originalExitCode = process.exitCode ?? 0
  let stderr = ""

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {},
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await task
    expect(stderr).toContain("Run `opencode auth login https://example.com` to re-authenticate.")
    expect(stderr).not.toContain("Unexpected server error")
    expect(process.exitCode).toBe(1)
    expect(setup.renderer.isDestroyed).toBe(true)
    expect(disposes).toBe(1)
  } finally {
    process.stderr.write = originalWrite
    process.exitCode = originalExitCode
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
