/** @jsxImportSource @opentui/solid */
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import type { GlobalEvent, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { createTuiAttention } from "../../../src/attention"
import { CommandPaletteDialog } from "../../../src/component/command-palette"
import { TuiConfigProvider, useTuiConfig } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { DataProvider } from "../../../src/context/data"
import { EditorContextProvider } from "../../../src/context/editor"
import { EpilogueProvider } from "../../../src/context/epilogue"
import { useEvent } from "../../../src/context/event"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider, useKV } from "../../../src/context/kv"
import { LocalProvider, useLocal } from "../../../src/context/local"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { PromptRefProvider, usePromptRef } from "../../../src/context/prompt"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { SDKProvider, useSDK } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider, useTheme } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings, useOpencodeKeymap } from "../../../src/keymap"
import { createTuiApiAdapters, createTuiApi } from "../../../src/plugin/adapters"
import { createPluginRuntime, PluginRuntimeProvider, usePluginRuntime } from "../../../src/plugin/runtime"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { PromptHistoryProvider, type PromptInfo } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { Session } from "../../../src/routes/session"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider, useToast } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, json, type FetchHandler } from "../../fixture/tui-sdk"

const wait = async (check: () => boolean | Promise<boolean>) => {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > 3000) throw new Error("timed out waiting for Session UI")
    await Bun.sleep(10)
  }
}

const mountSession = async (
  root: string,
  options: {
    width?: number
    supported?: boolean
    seed?: PromptInfo
    pending?: { permission: PermissionRequest[]; question: QuestionRequest[] }
    pendingFetch?: FetchHandler
    events?: ReturnType<typeof createEventSource>
    sessionDirectory?: string
  } = {},
) => {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), JSON.stringify({ animations_enabled: false }))
  const events = options.events ?? createEventSource()
  const session = {
    id: "ses_parent",
    projectID: "proj_test",
    directory: options.sessionDirectory ?? root,
    title: "Parent task",
    agent: "build",
    slug: "parent-task",
    version: "1",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
  const defaults = createFetch((url) => {
    if (url.pathname === "/permission") return options.pendingFetch?.(url) ?? json(options.pending?.permission ?? [])
    if (url.pathname === "/question") return options.pendingFetch?.(url) ?? json(options.pending?.question ?? [])
    if (url.pathname === "/experimental/capabilities")
      return json(
        options.supported === false
          ? {}
          : {
              sessionAside: { version: 1, cancel: true },
              sessionInput: { version: 1, delivery: ["queue", "steer"], list: true, cancel: true },
            },
      )
    if (url.pathname.endsWith("/input"))
      return json({ items: [...receipts.values()].filter((row) => row.state === "pending"), next: null })
    if (url.pathname.includes("/input/"))
      return receipts.has(url.pathname.split("/").at(-1)!)
        ? json(receipts.get(url.pathname.split("/").at(-1)!))
        : json({}, { status: 404 })
    if (url.pathname === "/project/proj_test/directories") return json([{ directory: root }])
    if (url.pathname === "/path") return json({ home: root, state, config: root, worktree: root, directory: root })
    if (url.pathname === "/session/ses_parent") return json(session)
    if (url.pathname === "/session/ses_other") return json({ ...session, id: "ses_other" })
    if (url.pathname === "/session") return json([session])
    if (url.pathname === "/session/status") return json({ ses_parent: { type: "busy" } })
    if (/\/session\/ses_(parent|other)\/(message|todo|diff)$/.test(url.pathname)) return json([])
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
    return undefined
  })
  const requests: Request[] = []
  const cancels: Request[] = []
  const reads: string[] = []
  const responses: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  const receipts = new Map<string, { requestID: string; delivery: string; text: string; state: string }>()
  let cancelRace = false
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (request.method === "GET") {
      reads.push(new URL(request.url).pathname)
      return defaults.fetch(request)
    }
    if (request.method === "DELETE" && new URL(request.url).pathname.startsWith("/session/ses_parent/aside/")) {
      cancels.push(request)
      return json(true)
    }
    if (request.method === "DELETE" && new URL(request.url).pathname.includes("/input/")) {
      cancels.push(request)
      const row = receipts.get(new URL(request.url).pathname.split("/").at(-1)!)!
      row.state = cancelRace ? "promoted" : "cancelled"
      return json(row, { status: cancelRace ? 409 : 200 })
    }
    requests.push(request)
    if (!["/session/ses_parent/aside", "/session/ses_parent/input"].includes(new URL(request.url).pathname))
      throw new Error(`Unexpected mutation: ${request.method} ${new URL(request.url).pathname}`)
    const response = Promise.withResolvers<Response>()
    responses.push(response)
    return response.promise
  }) as typeof fetch
  let prompt!: ReturnType<typeof usePromptRef>
  let sync!: ReturnType<typeof useSync>
  let route!: ReturnType<typeof useRoute>
  let local!: ReturnType<typeof useLocal>

  const Screen = () => {
    prompt = usePromptRef()
    sync = useSync()
    route = useRoute()
    local = useLocal()
    const dialog = useDialog()
    const renderer = useRenderer()
    const runtime = usePluginRuntime()
    const config = useTuiConfig()
    const kv = useKV()
    const attention = createTuiAttention({ renderer, config, kv })
    const slots = runtime.setupSlots(
      createTuiApi(
        createTuiApiAdapters({
          version: "test",
          tuiConfig: config,
          dialog,
          keymap: useOpencodeKeymap(),
          kv,
          route: useRoute(),
          routes: runtime.routes,
          event: useEvent(),
          sdk: useSDK(),
          sync,
          theme: useTheme(),
          toast: useToast(),
          renderer,
          attention,
          Slot: runtime.Slot,
        }),
      ),
    )
    onCleanup(() => {
      slots.dispose()
      attention.dispose()
    })
    useBindings(() => ({
      bindings: [{ key: "ctrl+p", desc: "Commands", cmd: () => dialog.replace(() => <CommandPaletteDialog />) }],
    }))
    return <Session />
  }

  const Harness = () => {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ExitProvider exit={() => {}}>
          <EpilogueProvider set={() => {}}>
            <OpencodeKeymapProvider keymap={keymap}>
              <ArgsProvider>
                <KVProvider>
                  <ToastProvider>
                    <RouteProvider initialRoute={{ type: "session", sessionID: "ses_parent", prompt: options.seed }}>
                      <TuiConfigProvider config={config}>
                        <PluginRuntimeProvider value={createPluginRuntime()}>
                          <SDKProvider
                            url="http://aside.test"
                            directory={root}
                            fetch={transport}
                            events={events.source}
                          >
                            <PermissionProvider>
                              <ProjectProvider>
                                <SyncProvider>
                                  <DataProvider>
                                    <ThemeProvider mode="dark">
                                      <LocalProvider>
                                        <PromptStashProvider>
                                          <DialogProvider>
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>
                                                  <EditorContextProvider integration={{}}>
                                                    <Screen />
                                                  </EditorContextProvider>
                                                </PromptRefProvider>
                                              </PromptHistoryProvider>
                                            </FrecencyProvider>
                                          </DialogProvider>
                                        </PromptStashProvider>
                                      </LocalProvider>
                                    </ThemeProvider>
                                  </DataProvider>
                                </SyncProvider>
                              </ProjectProvider>
                            </PermissionProvider>
                          </SDKProvider>
                        </PluginRuntimeProvider>
                      </TuiConfigProvider>
                    </RouteProvider>
                  </ToastProvider>
                </KVProvider>
              </ArgsProvider>
            </OpencodeKeymapProvider>
          </EpilogueProvider>
        </ExitProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: options.width ?? 100, height: 48, kittyKeyboard: true })
  await wait(() => sync?.status === "complete" && !!prompt?.current?.focused).catch(async (error) => {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    app.renderer.destroy()
    throw new Error(`${error.message}: status=${sync?.status}, reads=${reads.join(",")}\n${frame}`)
  })
  await sync.session.sync("ses_parent")
  const editor = app.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Main Prompt textarea not mounted")
  if (!options.seed) prompt.current!.reset()
  return {
    app,
    editor,
    prompt,
    sync,
    route,
    local,
    receipts,
    setCancelRace() {
      cancelRace = true
    },
    async click(label: string) {
      await wait(async () => {
        await app.renderOnce()
        return !app.captureCharFrame().includes("Checking server support")
      })
      await app.renderOnce()
      const lines = app.captureCharFrame().split("\n")
      const y = lines.findIndex((line) => line.includes(label))
      if (y < 0) throw new Error(`Missing clickable label ${label}\n${lines.join("\n")}`)
      await app.mockMouse.click(lines[y].indexOf(label) + 1, y)
    },
    emit: events.emit,
    requests,
    cancels,
    responses,
    reads,
    async frame() {
      await app.renderOnce()
      return app.captureCharFrame()
    },
    [Symbol.dispose]() {
      prompt.current?.reset()
      app.renderer.destroy()
    },
  }
}

test("attach hydrates existing human requests without stealing composer focus or approving them", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path, {
    pending: {
      permission: [
        {
          id: "per_existing",
          sessionID: "ses_parent",
          permission: "bash",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        },
      ],
      question: [
        {
          id: "que_existing",
          sessionID: "ses_parent",
          questions: [
            { header: "Choice", question: "Existing question?", options: [{ label: "One", description: "First" }] },
          ],
        },
      ],
    },
  })
  expect(await view.frame()).toContain("Review human request")
  expect(view.sync.data.permission.ses_parent.map((item) => item.id)).toEqual(["per_existing"])
  expect(view.sync.data.question.ses_parent.map((item) => item.id)).toEqual(["que_existing"])
  expect(view.editor.focused).toBe(true)
  await view.app.mockInput.typeText("Not an approval 123")
  view.app.mockInput.pressKey("g", { meta: true })
  expect(await view.frame()).toContain("Permission required")
  view.app.mockInput.pressKey("g", { meta: true })
  expect(view.editor.focused).toBe(true)
  expect(view.prompt.current!.current.input).toBe("Not an approval 123")
  expect(view.requests).toHaveLength(0)
})

test("explicit modes display the session agent rather than local selection without changing the payload", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  view.local.agent.set("plan")
  expect(view.local.agent.current()?.name).toBe("plan")
  expect(await view.frame()).toContain("Build")
  expect(await view.frame()).not.toContain("Plan")
  expect(await view.frame()).not.toContain("agents")
  await view.click("Steer")
  expect(await view.frame()).toContain("Build")
  expect(await view.frame()).not.toContain("Plan")
  await view.click("Aside")
  expect(await view.frame()).toContain("Build")
  expect(await view.frame()).not.toContain("Plan")
  await view.app.mockInput.typeText("Which agent is handling this?")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  expect(await view.requests[0].clone().json()).toEqual({
    requestID: expect.any(String),
    question: "Which agent is handling this?",
  })
  expect(view.sync.session.get("ses_parent")?.agent).toBe("build")
  view.app.mockInput.pressEscape()
  view.emit({
    directory: tmp.path,
    payload: {
      id: "evt_idle",
      type: "session.status",
      properties: { sessionID: "ses_parent", status: { type: "idle" } },
    },
  })
  await wait(() => view.sync.data.session_status.ses_parent.type === "idle")
  await view.click("Use normal Send")
  expect(await view.frame()).toContain("Plan")
  expect(await view.frame()).toContain("agents")
})

test("unscoped reconnect replaces missed human requests without stealing focus", async () => {
  await using tmp = await tmpdir()
  const pending = {
    permission: [
      { id: "per_old", sessionID: "ses_parent", permission: "bash", patterns: ["*"], always: ["*"], metadata: {} },
    ],
    question: [
      {
        id: "que_old",
        sessionID: "ses_parent",
        questions: [{ header: "Old", question: "Old question?", options: [] }],
      },
    ],
  }
  using view = await mountSession(tmp.path, { pending })
  await view.app.mockInput.typeText("Keep composing")
  pending.permission = []
  pending.question = [
    { ...pending.question[0], id: "que_new", questions: [{ header: "New", question: "New question?", options: [] }] },
  ]
  // /global/event sends server.connected without location metadata.
  view.emit({ payload: { id: "evt_connected", type: "server.connected", properties: {} } } as GlobalEvent)
  await wait(() => view.sync.data.question.ses_parent?.[0]?.id === "que_new")
  expect(view.sync.data.permission.ses_parent).toEqual([])
  expect(await view.frame()).toContain("Review human request")
  expect(view.editor.focused).toBe(true)
  expect(view.prompt.current!.current.input).toBe("Keep composing")
  view.app.mockInput.pressKey("g", { meta: true })
  expect(await view.frame()).toContain("New question?")
  expect(await view.frame()).not.toContain("Old question?")
  view.app.mockInput.pressKey("g", { meta: true })
  expect(view.editor.focused).toBe(true)
  expect(view.requests).toHaveLength(0)
})

test("a reply during initial attach cannot resurrect a stale snapshot gate", async () => {
  await using tmp = await tmpdir()
  const events = createEventSource()
  const snapshot = Promise.withResolvers<Response>()
  let requested = false
  const mounted = mountSession(tmp.path, {
    events,
    pendingFetch: (url) => {
      if (url.pathname !== "/question") return
      if (requested) return json([])
      requested = true
      return snapshot.promise
    },
  })
  await wait(() => requested)
  events.emit({
    directory: tmp.path,
    payload: {
      id: "evt_reply",
      type: "question.rejected",
      properties: { sessionID: "ses_parent", requestID: "que_answered" },
    },
  })
  snapshot.resolve(
    json([
      {
        id: "que_answered",
        sessionID: "ses_parent",
        questions: [{ header: "Old", question: "Already answered?", options: [] }],
      },
    ]),
  )
  using view = await mounted
  expect(view.sync.data.question.ses_parent ?? []).toEqual([])
  expect(await view.frame()).not.toContain("Review human request")
  expect(view.editor.focused).toBe(true)
  expect(view.requests).toHaveLength(0)
})

test("concurrent reconnect events win over stale human-request snapshots in the rendered session", async () => {
  await using tmp = await tmpdir()
  const permissions = Promise.withResolvers<Response>()
  const questions = Promise.withResolvers<Response>()
  let delayed = false
  const requested: string[] = []
  using view = await mountSession(tmp.path, {
    pendingFetch: (url) => {
      if (!delayed) return
      requested.push(url.pathname)
      return url.pathname === "/permission" ? permissions.promise : questions.promise
    },
  })
  delayed = true
  view.emit({ payload: { id: "evt_connected", type: "server.connected", properties: {} } } as GlobalEvent)
  await wait(() => requested.length === 2)
  view.emit({
    directory: tmp.path,
    payload: {
      id: "evt_replied",
      type: "permission.replied",
      properties: { sessionID: "ses_parent", requestID: "per_old", reply: "once" },
    },
  })
  view.emit({
    directory: tmp.path,
    payload: {
      id: "evt_rejected",
      type: "question.rejected",
      properties: { sessionID: "ses_parent", requestID: "que_old" },
    },
  })
  view.emit({
    directory: tmp.path,
    payload: {
      id: "evt_asked",
      type: "question.asked",
      properties: {
        id: "que_live",
        sessionID: "ses_parent",
        questions: [{ header: "Live", question: "Live question?", options: [] }],
      },
    },
  })
  await wait(() => view.sync.data.question.ses_parent?.[0]?.id === "que_live")
  permissions.resolve(
    json([
      { id: "per_old", sessionID: "ses_parent", permission: "bash", patterns: ["*"], always: ["*"], metadata: {} },
    ]),
  )
  questions.resolve(
    json([
      {
        id: "que_old",
        sessionID: "ses_parent",
        questions: [{ header: "Old", question: "Stale question?", options: [] }],
      },
      {
        id: "que_snapshot",
        sessionID: "ses_parent",
        questions: [{ header: "Snapshot", question: "Snapshot question?", options: [] }],
      },
    ]),
  )
  await wait(() => view.sync.data.question.ses_parent?.length === 2)
  expect(view.sync.data.question.ses_parent.map((item) => item.id)).toEqual(["que_live", "que_snapshot"])
  expect(view.sync.data.permission.ses_parent ?? []).toEqual([])
  expect(view.editor.focused).toBe(true)
  view.app.mockInput.pressKey("g", { meta: true })
  expect(await view.frame()).toContain("Live question?")
  expect(await view.frame()).not.toContain("Stale question?")
  view.app.mockInput.pressKey("g", { meta: true })
  expect(view.requests).toHaveLength(0)
})

test("attach and reconnect hydrate the resumed session directory rather than just the attach directory", async () => {
  await using tmp = await tmpdir()
  const sessionDirectory = `${tmp.path}/resumed`
  let requestID = "que_existing"
  using view = await mountSession(tmp.path, {
    sessionDirectory,
    pendingFetch: (url) => {
      if (url.pathname !== "/question") return json([])
      if (url.searchParams.get("directory") !== sessionDirectory) return json([])
      return json([
        {
          id: requestID,
          sessionID: "ses_parent",
          questions: [{ header: "Resumed", question: "Resumed session question?", options: [] }],
        },
      ])
    },
  })
  expect(view.sync.data.question.ses_parent.map((item) => item.id)).toEqual(["que_existing"])
  expect(await view.frame()).toContain("Review human request")
  expect(view.editor.focused).toBe(true)
  requestID = "que_reconnected"
  view.emit({ payload: { id: "evt_connected", type: "server.connected", properties: {} } } as GlobalEvent)
  await wait(() => view.sync.data.question.ses_parent?.[0]?.id === "que_reconnected")
  view.app.mockInput.pressKey("g", { meta: true })
  expect(await view.frame()).toContain("Resumed session question?")
  view.app.mockInput.pressKey("g", { meta: true })
  expect(view.requests).toHaveLength(0)
})

test("Aside palette selection preserves the real Session Prompt draft, attachment, cursor and focus", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  const draft: PromptInfo = {
    input: "main draft [file:1] keep working",
    parts: [
      {
        type: "file",
        mime: "text/plain",
        filename: "attachment.txt",
        url: `file://${tmp.path}/attachment.txt`,
        source: { type: "file", path: "attachment.txt", text: { start: 11, end: 19, value: "[file:1]" } },
      },
    ],
  }
  view.prompt.current!.set(structuredClone(draft))
  view.editor.cursorOffset = 5
  const prompt = view.prompt.current
  const extmarks = structuredClone(view.editor.extmarks.getAll())
  expect(extmarks).toHaveLength(1)
  view.app.mockInput.pressKey("p", { ctrl: true })
  await wait(() => view.app.renderer.currentFocusedRenderable instanceof InputRenderable)
  await view.app.mockInput.typeText("Aside")
  expect(await view.frame()).toContain("Ask a side question (Aside)")
  view.app.mockInput.pressEnter()
  await wait(async () => (await view.frame()).includes("[Aside]") && view.editor.focused).catch(async (error) => {
    throw new Error(`${error.message}\n${await view.frame()}`)
  })
  expect(view.prompt.current!.current).toEqual(draft)
  expect(await view.frame()).toContain("Text only")
  view.prompt.current!.reset()
  await view.app.mockInput.typeText("Independent question")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  expect((await view.requests[0].json()).question).toBe("Independent question")
  expect(view.prompt.current).toBe(prompt)
  expect(view.editor.focused).toBe(true)
  expect(view.prompt.current!.current.input).toBe("Independent question")
  expect(view.sync.data.session_status.ses_parent).toEqual({ type: "busy" })
  view.responses[0].resolve(
    json({
      requestID: "answer",
      text: "Independent answer",
      snapshot: {
        capturedAt: 0,
        excludedMessageCount: 3,
        activity: { status: "busy", tools: [{ name: "bash", status: "running" }] },
      },
    }),
  )
  await wait(async () => (await view.frame()).includes("Independent answer"))
  expect(await view.frame()).toContain("Independent answer")
  view.emit({
    directory: tmp.path,
    payload: {
      id: "evt_parent_idle",
      type: "session.status",
      properties: { sessionID: "ses_parent", status: { type: "idle" } },
    },
  })
  await wait(() => view.sync.data.session_status.ses_parent.type === "idle")
  expect(await view.frame()).toContain("Parent activity at capture (not live): busy")
  expect(view.editor.focused).toBe(true)
  view.app.mockInput.pressEscape()
  await wait(() => view.editor.focused)
  expect(view.prompt.current).toBe(prompt)
  expect(view.editor.isDestroyed).toBe(false)
  expect(view.prompt.current!.current).toEqual(draft)
  expect(view.editor.cursorOffset).toBe(5)
  expect(view.editor.extmarks.getAll().map(({ id, ...mark }) => mark)).toEqual(extmarks.map(({ id, ...mark }) => mark))
  expect(view.requests).toHaveLength(1)
  expect(view.cancels).toHaveLength(0)
})

test("Aside mode is clickable, cancels independently, and has no /btw slash entry", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  await view.click("Aside")
  expect(await view.frame()).toContain("[Aside]")
  expect(view.requests).toHaveLength(0)
  expect(view.prompt.current!.current.input).toBe("")
  await view.app.mockInput.typeText("Only in Aside")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  const body = await view.requests[0].json()
  expect(body.question).toBe("Only in Aside")
  view.app.mockInput.pressEscape()
  expect(view.requests[0].signal.aborted).toBe(true)
  await wait(() => view.cancels.length === 1)
  expect(new URL(view.cancels[0].url).pathname).toBe(`/session/ses_parent/aside/${body.requestID}`)
  expect(view.cancels[0].signal.aborted).toBe(false)
  expect(view.sync.data.session_status.ses_parent).toEqual({ type: "busy" })
  await wait(() => view.editor.focused)
  expect(view.prompt.current!.current.input).toBe("")
  expect(view.requests).toHaveLength(1)
  expect(view.cancels).toHaveLength(1)
  await view.app.mockInput.typeText("/btw")
  expect(await view.frame()).not.toContain("Ask a side question (Aside)")
})

test("Queue defaults while busy, duplicate Enter admits once, and acknowledgement preserves newer typing", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  expect(await view.frame()).toContain("[Queue]")
  await view.app.mockInput.typeText("Original task draft")
  view.app.mockInput.pressEnter()
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  const body = await view.requests[0].clone().json()
  expect(body).toEqual({ requestID: expect.any(String), delivery: "queue", text: "Original task draft" })
  await view.app.mockInput.typeText(" with a newer edit")
  view.responses[0].resolve(json({ ...body, state: "pending" }))
  await wait(async () => (await view.frame()).includes("Input pending"))
  expect(view.prompt.current!.current.input).toBe("Original task draft with a newer edit")
  expect(view.requests).toHaveLength(1)
  view.app.mockInput.pressKey("m", { meta: true })
  expect(await view.frame()).toContain("[Steer]")
  expect(view.prompt.current!.current.input).toBe("Original task draft with a newer edit")
  view.emit({
    directory: tmp.path,
    payload: {
      id: "evt_idle",
      type: "session.status",
      properties: { sessionID: "ses_parent", status: { type: "idle" } },
    },
  })
  await wait(() => view.sync.data.session_status.ses_parent.type === "idle")
  expect(await view.frame()).toContain("Enter: Steer task")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 2)
  const second = await view.requests[1].clone().json()
  expect(second.delivery).toBe("steer")
  view.responses[1].resolve(json({ ...second, state: "promoted" }))
  await wait(() => view.prompt.current!.current.input === "")
  expect(await view.frame()).toContain("not completed")
})

test("unknown acknowledgement retains immutable payload and same request ID for explicit retry", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  await view.app.mockInput.typeText("Admit exactly once")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  const first = await view.requests[0].clone().json()
  view.responses[0].reject(new Error("lost response"))
  await wait(async () => (await view.frame()).includes("Acknowledgement unknown"))
  await view.app.mockInput.typeText(" newer")
  view.app.mockInput.pressEnter()
  expect(view.requests).toHaveLength(1)
  await view.click("Retry same input")
  await wait(() => view.requests.length === 2)
  expect(await view.requests[1].clone().json()).toEqual(first)
  view.responses[1].resolve(json({ ...first, state: "pending" }))
  await wait(async () => (await view.frame()).includes("Input pending"))
  expect(view.prompt.current!.current.input).toBe("Admit exactly once newer")
})

test("unsupported servers and attachments never fall back to legacy prompt", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path, { supported: false, width: 48 })
  await view.app.mockInput.typeText("Keep this draft")
  await wait(async () => (await view.frame()).includes("Server does not support"))
  view.app.mockInput.pressEnter()
  await view.click("Aside")
  view.app.mockInput.pressEnter()
  await Bun.sleep(30)
  expect(view.requests).toHaveLength(0)
  expect(view.prompt.current!.current.input).toBe("Keep this draft")
  expect(await view.frame()).toContain("[Aside]")
})

test("pending cancellation reports a promotion race and refreshes authoritative rows", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  view.receipts.set("req_race", { requestID: "req_race", delivery: "queue", text: "Race input", state: "pending" })
  view.emit({ directory: tmp.path, payload: { id: "evt_connected", type: "server.connected", properties: {} } })
  await wait(async () => (await view.frame()).includes("Race input"))
  view.setCancelRace()
  await view.click("[cancel]")
  await wait(async () => (await view.frame()).includes("cancellation lost the race"))
  expect(await view.frame()).not.toContain("Race input")
  expect(view.cancels).toHaveLength(1)
})

test("route changes isolate drafts, cancel Aside, and ignore late answers", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  await view.app.mockInput.typeText("Saved parent task")
  await view.click("Aside")
  view.prompt.current!.reset()
  await view.app.mockInput.typeText("Parent side question")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  view.route.navigate({ type: "session", sessionID: "ses_other" })
  await wait(() => view.prompt.current?.current.input === "" && view.cancels.length === 1)
  await view.app.mockInput.typeText("Other session draft")
  view.responses[0].resolve(
    json({
      requestID: "late",
      text: "Must not leak",
      snapshot: { capturedAt: 0, excludedMessageCount: 0, activity: { status: "busy", tools: [] } },
    }),
  )
  expect(await view.frame()).not.toContain("Must not leak")
  view.route.navigate({ type: "session", sessionID: "ses_parent" })
  await wait(() => view.prompt.current?.current.input === "Parent side question")
  await view.click("Queue")
  expect(await view.frame()).toContain("[Queue]")
  expect(view.prompt.current!.current.input).toBe("Saved parent task")
})

test("human permission remains pending while composer mode selection and typing are active", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  view.emit({
    directory: tmp.path,
    payload: {
      id: "evt_permission",
      type: "permission.asked",
      properties: {
        id: "per_gate",
        sessionID: "ses_parent",
        permission: "bash",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
      },
    },
  })
  await wait(async () => (await view.frame()).includes("Review human request"))
  expect(view.editor.focused).toBe(true)
  view.app.mockInput.pressKey("g", { meta: true })
  await wait(async () => (await view.frame()).includes("Permission required"))
  expect(view.editor.focused).toBe(false)
  view.app.mockInput.pressKey("g", { meta: true })
  await wait(() => view.editor.focused)
  await view.click("Aside")
  await view.app.mockInput.typeText("hello 123")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  expect(new URL(view.requests[0].url).pathname).toBe("/session/ses_parent/aside")
  expect(view.sync.data.permission.ses_parent).toHaveLength(1)
  view.app.mockInput.pressEscape()
  expect(view.sync.data.permission.ses_parent).toHaveLength(1)
  view.app.mockInput.pressKey("g", { meta: true })
  await wait(async () => (await view.frame()).includes("Permission required"))
  expect(view.requests).toHaveLength(1)
})

test("late task acknowledgement after remount clears only its matching visible draft", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  await view.app.mockInput.typeText("Do not admit twice")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  const body = await view.requests[0].clone().json()
  view.route.navigate({ type: "session", sessionID: "ses_other" })
  await wait(() => view.prompt.current?.current.input === "")
  await view.app.mockInput.typeText("Other draft stays")
  view.route.navigate({ type: "session", sessionID: "ses_parent" })
  await wait(() => view.prompt.current?.current.input === "Do not admit twice")
  view.responses[0].resolve(json({ ...body, state: "pending" }))
  await wait(() => view.prompt.current?.current.input === "")
  view.app.mockInput.pressEnter()
  expect(view.requests).toHaveLength(1)
  view.route.navigate({ type: "session", sessionID: "ses_other" })
  await wait(() => view.prompt.current?.current.input === "Other draft stays")
})

test("late task acknowledgement after remount does not erase a newer revision", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  await view.app.mockInput.typeText("Submitted draft")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  const body = await view.requests[0].clone().json()
  view.route.navigate({ type: "session", sessionID: "ses_other" })
  await wait(() => view.prompt.current?.current.input === "")
  view.route.navigate({ type: "session", sessionID: "ses_parent" })
  await wait(() => view.prompt.current?.current.input === "Submitted draft")
  await view.app.mockInput.typeText(" edited on return")
  view.responses[0].resolve(json({ ...body, state: "pending" }))
  await wait(async () => (await view.frame()).includes("Input pending"))
  expect(view.prompt.current!.current.input).toBe("Submitted draft edited on return")
})

test("reconnect reconciles a lost acknowledgement without resubmission or normal Send fallback", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  await view.app.mockInput.typeText("Durable on server")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  const body = await view.requests[0].clone().json()
  view.responses[0].reject(new Error("connection lost"))
  await wait(async () => (await view.frame()).includes("Acknowledgement unknown"))
  view.emit({
    directory: tmp.path,
    payload: {
      id: "evt_idle",
      type: "session.status",
      properties: { sessionID: "ses_parent", status: { type: "idle" } },
    },
  })
  await wait(() => view.sync.data.session_status.ses_parent.type === "idle")
  expect(await view.frame()).not.toContain("Use normal Send")
  view.receipts.set(body.requestID, { ...body, state: "pending" })
  view.emit({ directory: tmp.path, payload: { id: "evt_connected", type: "server.connected", properties: {} } })
  await wait(() => view.prompt.current?.current.input === "")
  expect(view.requests).toHaveLength(1)
  expect(await view.frame()).toContain("Durable on server")
})

test("pasted text is expanded through real extmarks before Queue transport", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  view.prompt.current!.set({
    input: "Expand [Pasted text]",
    parts: [
      {
        type: "text",
        text: "the actual pasted content",
        source: { text: { value: "[Pasted text]", start: 7, end: 20 } },
      },
    ],
  })
  expect(view.editor.extmarks.getAll()).toHaveLength(1)
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  const body = await view.requests[0].clone().json()
  expect(body.text).toBe("Expand the actual pasted content")
  view.responses[0].resolve(json({ ...body, state: "pending" }))
  await wait(() => view.prompt.current!.current.input === "")
})

test("route-seeded composer draft survives initialization", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path, { seed: { input: "Forked user message", parts: [] } })
  expect(view.prompt.current!.current.input).toBe("Forked user message")
})

test("question custom answer survives safe focus switching without approval", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  view.emit({
    directory: tmp.path,
    payload: {
      id: "evt_question",
      type: "question.asked",
      properties: {
        id: "que_gate",
        sessionID: "ses_parent",
        questions: [{ header: "Choice", question: "Which option?", options: [{ label: "One", description: "First" }] }],
      },
    },
  })
  await wait(async () => (await view.frame()).includes("Review human request"))
  view.app.mockInput.pressKey("g", { meta: true })
  await wait(async () => (await view.frame()).includes("Which option?"))
  view.app.mockInput.pressKey("2")
  await wait(() => view.app.renderer.currentFocusedEditor instanceof TextareaRenderable && !view.editor.focused)
  await view.app.mockInput.typeText("Unsubmitted answer")
  view.app.mockInput.pressKey("g", { meta: true })
  await wait(() => view.editor.focused)
  await view.click("Aside")
  await view.app.mockInput.typeText("hello 123")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  expect(new URL(view.requests[0].url).pathname).toBe("/session/ses_parent/aside")
  view.app.mockInput.pressEscape()
  expect(view.sync.data.question.ses_parent).toHaveLength(1)
  expect(await view.frame()).not.toContain("Close Aside")
  view.app.mockInput.pressKey("g", { meta: true })
  await wait(async () => (await view.frame()).includes("Unsubmitted answer"))
  expect(view.sync.data.question.ses_parent).toHaveLength(1)
})

test("permission takes focus precedence when a question is also pending", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  view.emit({
    directory: tmp.path,
    payload: {
      id: "evt_question",
      type: "question.asked",
      properties: {
        id: "que_gate",
        sessionID: "ses_parent",
        questions: [{ header: "Choice", question: "Which option?", options: [{ label: "One", description: "First" }] }],
      },
    },
  })
  view.emit({
    directory: tmp.path,
    payload: {
      id: "evt_permission",
      type: "permission.asked",
      properties: {
        id: "per_gate",
        sessionID: "ses_parent",
        permission: "bash",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
      },
    },
  })
  await wait(() => view.sync.data.permission.ses_parent?.length === 1)
  view.app.mockInput.pressKey("g", { meta: true })
  await wait(async () => (await view.frame()).includes("Permission required"))
  view.app.mockInput.pressKey("g", { meta: true })
  await wait(() => view.editor.focused)
  await view.app.mockInput.typeText("Not an approval 123")
  expect(view.sync.data.permission.ses_parent).toHaveLength(1)
  expect(view.sync.data.question.ses_parent).toHaveLength(1)
  expect(view.requests).toHaveLength(0)
})

test("deleting the task draft preserves native undo history", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  await view.app.mockInput.typeText("Recover this draft")
  view.app.mockInput.pressKey("u", { ctrl: true })
  await wait(() => view.editor.plainText === "")
  view.app.mockInput.pressKey("-", { ctrl: true })
  await wait(() => view.editor.plainText === "Recover this draft")
  await view.click("Aside")
  expect(view.prompt.current!.current.input).toBe("Recover this draft")
  await view.click("Queue")
  expect(view.prompt.current!.current.input).toBe("Recover this draft")
})

test("a full final pending-input page is rendered without requesting a null cursor", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  for (let index = 0; index < 100; index++)
    view.receipts.set(`req_${index}`, {
      requestID: `req_${index}`,
      delivery: "queue",
      text: `Pending item ${index}`,
      state: "pending",
    })
  view.emit({ directory: tmp.path, payload: { id: "evt_connected", type: "server.connected", properties: {} } })
  await wait(async () => (await view.frame()).includes("Pending item 0"))
  expect(await view.frame()).not.toContain("Pending inputs unavailable")
})

test("new human requests never steal composer focus or interpret Enter as an approval", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  await view.app.mockInput.typeText("Keep composing")
  view.emit({
    directory: tmp.path,
    payload: {
      id: "evt_first",
      type: "permission.asked",
      properties: {
        id: "per_first",
        sessionID: "ses_parent",
        permission: "bash",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
      },
    },
  })
  await wait(() => view.sync.data.permission.ses_parent?.length === 1)
  expect(view.editor.focused).toBe(true)
  view.emit({
    directory: tmp.path,
    payload: {
      id: "evt_second",
      type: "permission.asked",
      properties: {
        id: "per_second",
        sessionID: "ses_parent",
        permission: "bash",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
      },
    },
  })
  await wait(() => view.sync.data.permission.ses_parent?.length === 2)
  expect(view.editor.focused).toBe(true)
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  expect(new URL(view.requests[0].url).pathname).toBe("/session/ses_parent/input")
  const body = await view.requests[0].clone().json()
  view.responses[0].resolve(json({ ...body, state: "pending" }))
  expect(view.sync.data.permission.ses_parent).toHaveLength(2)
})
