/** @jsxImportSource @opentui/solid */
import { InputRenderable, TextareaRenderable } from "@opentui/core"
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
import { LocalProvider } from "../../../src/context/local"
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
import { createEventSource, createFetch, json } from "../../fixture/tui-sdk"

const wait = async (check: () => boolean | Promise<boolean>) => {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > 3000) throw new Error("timed out waiting for Session UI")
    await Bun.sleep(10)
  }
}

const mountSession = async (root: string) => {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), JSON.stringify({ animations_enabled: false }))
  const events = createEventSource()
  const session = {
    id: "ses_parent",
    projectID: "proj_test",
    directory: root,
    title: "Parent task",
    slug: "parent-task",
    version: "1",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
  const defaults = createFetch((url) => {
    if (url.pathname === "/project/proj_test/directories") return json([{ directory: root }])
    if (url.pathname === "/path") return json({ home: root, state, config: root, worktree: root, directory: root })
    if (url.pathname === "/session/ses_parent") return json(session)
    if (url.pathname === "/session") return json([session])
    if (url.pathname === "/session/status") return json({ ses_parent: { type: "busy" } })
    if (["/session/ses_parent/message", "/session/ses_parent/todo", "/session/ses_parent/diff"].includes(url.pathname))
      return json([])
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", options: {}, permission: [] }])
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
    requests.push(request)
    if (new URL(request.url).pathname !== "/session/ses_parent/aside")
      throw new Error(`Unexpected mutation: ${request.method} ${new URL(request.url).pathname}`)
    const response = Promise.withResolvers<Response>()
    responses.push(response)
    return response.promise
  }) as typeof fetch
  let prompt!: ReturnType<typeof usePromptRef>
  let sync!: ReturnType<typeof useSync>

  const Screen = () => {
    prompt = usePromptRef()
    sync = useSync()
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
                    <RouteProvider initialRoute={{ type: "session", sessionID: "ses_parent" }}>
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

  const app = await testRender(() => <Harness />, { width: 100, height: 48, kittyKeyboard: true })
  await wait(() => sync?.status === "complete" && !!prompt?.current?.focused).catch(async (error) => {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    app.renderer.destroy()
    throw new Error(`${error.message}: status=${sync?.status}, reads=${reads.join(",")}\n${frame}`)
  })
  const editor = app.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Main Prompt textarea not mounted")
  prompt.current!.reset()
  return {
    app,
    editor,
    prompt,
    sync,
    emit: events.emit,
    requests,
    cancels,
    responses,
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
  await wait(() => view.app.renderer.currentFocusedEditor instanceof TextareaRenderable && !view.editor.focused)
  await view.app.mockInput.typeText("Independent question")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  expect((await view.requests[0].json()).question).toBe("Independent question")
  expect(view.prompt.current).toBe(prompt)
  expect(view.editor.focused).toBe(false)
  expect(view.prompt.current!.current).toEqual(draft)
  expect(view.editor.cursorOffset).toBe(5)
  expect(view.editor.extmarks.getAll()).toEqual(extmarks)
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
  expect(view.editor.focused).toBe(false)
  view.app.mockInput.pressEscape()
  await wait(() => view.editor.focused)
  expect(view.prompt.current).toBe(prompt)
  expect(view.editor.isDestroyed).toBe(false)
  expect(view.prompt.current!.current).toEqual(draft)
  expect(view.editor.cursorOffset).toBe(5)
  expect(view.editor.extmarks.getAll()).toEqual(extmarks)
  expect(view.requests).toHaveLength(1)
  expect(view.cancels).toHaveLength(0)
})

test("selecting /btw opens Aside without submitting the actual main Prompt", async () => {
  await using tmp = await tmpdir()
  using view = await mountSession(tmp.path)
  await view.app.mockInput.typeText("/btw")
  await wait(async () => (await view.frame()).includes("Ask a side question (Aside)"))
  expect(await view.frame()).toContain("Ask a side question (Aside)")
  view.app.mockInput.pressEnter()
  await wait(() => view.app.renderer.currentFocusedEditor instanceof TextareaRenderable && !view.editor.focused)
  expect(view.requests).toHaveLength(0)
  expect(view.prompt.current!.current.input).toBe("")
  await view.app.mockInput.typeText("Only in Aside")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  const body = await view.requests[0].json()
  expect(body.question).toBe("Only in Aside")
  view.app.mockInput.pressKey("g", { ctrl: true })
  expect(view.requests[0].signal.aborted).toBe(true)
  await wait(() => view.cancels.length === 1)
  expect(new URL(view.cancels[0].url).pathname).toBe(`/session/ses_parent/aside/${body.requestID}`)
  expect(view.cancels[0].signal.aborted).toBe(false)
  expect(view.sync.data.session_status.ses_parent).toEqual({ type: "busy" })
  view.app.mockInput.pressEscape()
  await wait(() => view.editor.focused)
  expect(view.prompt.current!.current.input).toBe("")
  expect(view.requests).toHaveLength(1)
  expect(view.cancels).toHaveLength(1)
})
