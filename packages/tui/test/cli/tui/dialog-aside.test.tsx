/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { DialogAside } from "../../../src/component/dialog-aside"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider } from "../../../src/context/kv"
import { SDKProvider } from "../../../src/context/sdk"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings } from "../../../src/keymap"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { eventSource, json } from "../../fixture/tui-sdk"

const wait = async (check: () => boolean) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 2000) throw new Error("timed out waiting for dialog state")
    await Bun.sleep(10)
  }
}

const mountAside = async (root: string, cancellation?: () => Promise<Response>) => {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const requests: Request[] = []
  const cancels: Request[] = []
  const responses: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (request.method === "DELETE") {
      cancels.push(request)
      return cancellation?.() ?? json(true)
    }
    requests.push(request)
    if (request.method !== "POST" || new URL(request.url).pathname !== "/session/ses_parent/aside")
      throw new Error(`Unexpected request: ${request.method} ${new URL(request.url).pathname}`)
    const response = Promise.withResolvers<Response>()
    responses.push(response)
    return response.promise
  }) as typeof fetch
  let parent!: TextareaRenderable
  let attachmentType!: number

  const Editor = () => {
    const dialog = useDialog()
    useBindings(() => ({
      bindings: [
        {
          key: "ctrl+b",
          desc: "Open Aside",
          cmd: () =>
            dialog.replace(() => (
              <DialogAside sessionID="ses_parent" model={{ providerID: "test", modelID: "model" }} agent="build" />
            )),
        },
      ],
    }))
    onMount(() => {
      attachmentType = parent.extmarks.registerType("attachment")
      parent.extmarks.create({ start: 11, end: 19, virtual: true, typeId: attachmentType })
      parent.cursorOffset = 5
      parent.focus()
    })
    return <textarea ref={parent} initialValue="main draft [file:1] keep working" height={3} />
  }

  const Harness = () => {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({
      keybinds: { input_submit: "super+return", input_newline: "return,shift+return,alt+return,ctrl+j" },
    })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <SDKProvider url="http://aside.test" fetch={transport} events={eventSource()}>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <Editor />
                    </DialogProvider>
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </SDKProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 48, kittyKeyboard: true })
  await wait(() => parent?.focused)
  const attachments = structuredClone(parent.extmarks.getAllForTypeId(attachmentType))
  return {
    app,
    parent,
    requests,
    cancels,
    responses,
    async open() {
      app.mockInput.pressKey("b", { ctrl: true })
      await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable && !parent.focused)
    },
    async frame() {
      await app.renderOnce()
      return app.captureCharFrame()
    },
    assertParent() {
      expect(parent.isDestroyed).toBe(false)
      expect(parent.plainText).toBe("main draft [file:1] keep working")
      expect(parent.cursorOffset).toBe(5)
      expect(parent.extmarks.getAllForTypeId(attachmentType)).toEqual(attachments)
    },
    [Symbol.dispose]() {
      app.renderer.destroy()
    },
  }
}

test("Aside uses its own input and displays a snapshot answer without changing the parent editor", async () => {
  await using tmp = await tmpdir()
  using view = await mountAside(tmp.path)
  await view.open()
  view.app.mockInput.pressEnter()
  expect(view.requests).toHaveLength(0)
  await view.app.mockInput.typeText("What does this mean?")
  view.assertParent()
  expect(view.parent.focused).toBe(false)
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  const request = view.requests[0]
  expect(new URL(request.url).pathname).toBe("/session/ses_parent/aside")
  expect(request.method).toBe("POST")
  const body = await request.json()
  expect(body).toEqual({
    requestID: expect.any(String),
    question: "What does this mean?",
    model: { providerID: "test", modelID: "model" },
    agent: "build",
  })
  view.responses[0].resolve(
    json({
      requestID: body.requestID,
      text: "A separate answer.",
      snapshot: {
        capturedAt: 1_700_000_000_000,
        throughMessageID: "msg_finished",
        excludedMessageCount: 2,
        activity: {
          status: "busy",
          tools: [
            { name: "bash", status: "running", args: { command: "TOOL_ARGUMENT_MUST_NOT_RENDER" } },
            { name: "read", status: "pending" },
          ],
        },
      },
    }),
  )
  await wait(() => view.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const frame = await view.frame()
  expect(frame).toContain("A separate answer.")
  expect(frame).toContain("2023-11-14T22:13:20.000Z")
  expect(frame).toContain("Through: msg_finished")
  expect(frame).toContain("Excluded messages: 2")
  expect(frame).toContain("Ephemeral snapshot, not live. Aside uses no tools.")
  expect(frame).toContain("Parent activity at capture (not live): busy")
  expect(frame).toContain("Parent tools at capture: bash (running), read (pending)")
  expect(frame).not.toContain("TOOL_ARGUMENT_MUST_NOT_RENDER")
  expect(frame).toContain("This answer is not sent")
  expect(view.parent.focused).toBe(false)
  view.app.mockInput.pressEscape()
  await wait(() => view.parent.focused)
  view.assertParent()
  expect(view.requests).toHaveLength(1)
  expect(view.cancels).toHaveLength(0)
})

test("Aside prevents duplicate submission and cancel aborts only its request", async () => {
  await using tmp = await tmpdir()
  using view = await mountAside(tmp.path)
  await view.open()
  await view.app.mockInput.typeText("Side question")
  view.app.mockInput.pressEnter()
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  view.app.mockInput.pressEnter()
  expect(view.requests).toHaveLength(1)
  const first = await view.requests[0].json()
  view.app.mockInput.pressKey("g", { ctrl: true })
  expect(view.requests[0].signal.aborted).toBe(true)
  await wait(() => view.cancels.length === 1)
  expect(new URL(view.cancels[0].url).pathname).toBe(`/session/ses_parent/aside/${first.requestID}`)
  expect(view.cancels[0].signal.aborted).toBe(false)
  expect(await view.frame()).toContain("Cancellation requested.")
  view.app.mockInput.pressKey("g", { ctrl: true })
  expect(view.cancels).toHaveLength(1)
  view.assertParent()
  expect(view.parent.focused).toBe(false)
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 2)
  const second = await view.requests[1].json()
  expect(second.requestID).not.toBe(first.requestID)
  expect(view.requests[1].signal.aborted).toBe(false)
  view.responses[0].resolve(
    json({
      requestID: "late",
      text: "Stale answer",
      snapshot: { capturedAt: 0, excludedMessageCount: 0, activity: { status: "idle", tools: [] } },
    }),
  )
  expect(await view.frame()).not.toContain("Stale answer")
  view.app.mockInput.pressEscape()
  await wait(() => view.parent.focused)
  expect(view.requests[1].signal.aborted).toBe(true)
  await wait(() => view.cancels.length === 2)
  expect(new URL(view.cancels[1].url).pathname).toBe(`/session/ses_parent/aside/${second.requestID}`)
  view.assertParent()
})

test.each(["escape", "ctrl+c", "unmount"])("Aside %s aborts and late responses cannot reopen it", async (close) => {
  await using tmp = await tmpdir()
  using view = await mountAside(tmp.path)
  await view.open()
  await view.app.mockInput.typeText("Side question")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  const body = await view.requests[0].json()
  if (close === "unmount") view.app.renderer.destroy()
  if (close === "escape") view.app.mockInput.pressEscape()
  if (close === "ctrl+c") view.app.mockInput.pressKey("c", { ctrl: true })
  expect(view.requests[0].signal.aborted).toBe(true)
  await wait(() => view.cancels.length === 1)
  expect(new URL(view.cancels[0].url).pathname).toBe(`/session/ses_parent/aside/${body.requestID}`)
  expect(view.cancels[0].signal.aborted).toBe(false)
  view.responses[0].resolve(
    json({
      requestID: "late",
      text: "Late answer",
      snapshot: { capturedAt: 0, excludedMessageCount: 0, activity: { status: "idle", tools: [] } },
    }),
  )
  if (close === "unmount") return
  await wait(() => view.parent.focused)
  expect(await view.frame()).not.toContain("Late answer")
  view.assertParent()
  expect(view.requests).toHaveLength(1)
  expect(view.cancels).toHaveLength(1)
})

test("closing immediately after submit sends explicit cancellation once", async () => {
  await using tmp = await tmpdir()
  using view = await mountAside(tmp.path)
  await view.open()
  await view.app.mockInput.typeText("Close immediately")
  view.app.mockInput.pressEnter()
  view.app.mockInput.pressEscape()
  await wait(() => view.parent.focused && view.requests.length === 1 && view.cancels.length === 1)
  const body = await view.requests[0].json()
  expect(view.requests[0].signal.aborted).toBe(true)
  expect(new URL(view.cancels[0].url).pathname).toBe(`/session/ses_parent/aside/${body.requestID}`)
  expect(view.cancels[0].signal.aborted).toBe(false)
  view.responses[0].resolve(
    json({
      requestID: body.requestID,
      text: "Too late",
      snapshot: { capturedAt: 0, excludedMessageCount: 0, activity: { status: "idle", tools: [] } },
    }),
  )
  expect(await view.frame()).not.toContain("Too late")
  view.assertParent()
  expect(view.cancels).toHaveLength(1)
})

test.each([
  { name: "unacknowledged", response: async () => json(false) },
  {
    name: "failed",
    response: async () => {
      throw new Error("Cancellation transport unavailable")
    },
  },
])("$name cancellation does not claim the server stopped", async (cancellation) => {
  await using tmp = await tmpdir()
  using view = await mountAside(tmp.path, cancellation.response)
  await view.open()
  await view.app.mockInput.typeText("Side question")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  view.app.mockInput.pressKey("g", { ctrl: true })
  await wait(() => view.cancels.length === 1)
  const frame = await view.frame()
  expect(frame).toContain("Cancellation requested.")
  expect(frame).toContain("Server stop is not confirmed.")
  expect(frame).not.toContain("Aside cancelled")
  view.app.mockInput.pressEscape()
  await wait(() => view.parent.focused)
  expect(view.cancels).toHaveLength(1)
})

test.each([
  { status: 400, message: "Aside timed out" },
  { status: 500, message: "Provider unavailable" },
  { status: 504, message: "Aside timed out" },
])("Aside displays $status errors and keeps the question for retry", async (failure) => {
  await using tmp = await tmpdir()
  using view = await mountAside(tmp.path)
  await view.open()
  await view.app.mockInput.typeText("Keep this question")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  view.responses[0].resolve(json({ _tag: "AsideError", message: failure.message }, { status: failure.status }))
  await wait(() => view.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const frame = await view.frame()
  expect(frame).toContain(`Aside failed: ${failure.message}`)
  expect(frame).toContain("Keep this question")
  view.assertParent()
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 2)
  expect((await view.requests[1].json()).question).toBe("Keep this question")
})

test("long Aside answers remain scrollable in a short terminal", async () => {
  await using tmp = await tmpdir()
  using view = await mountAside(tmp.path)
  view.app.resize(100, 24)
  await view.open()
  await view.app.mockInput.typeText("Explain in detail")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  view.responses[0].resolve(
    json({
      requestID: "long",
      text: "Detail line\n".repeat(30) + "End of answer",
      snapshot: { capturedAt: 0, excludedMessageCount: 0, activity: { status: "idle", tools: [] } },
    }),
  )
  await wait(() => view.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  expect(await view.frame()).not.toContain("End of answer")
  for (let scroll = 0; scroll < 80; scroll++) {
    await view.app.mockMouse.scroll(50, 20, "down")
    await view.app.renderOnce()
  }
  expect(await view.frame()).toContain("End of answer")
  view.app.mockInput.pressEscape()
  await wait(() => view.parent.focused)
  view.assertParent()
})

test.each(["idle", "retry"])("Aside displays captured %s activity without active tools", async (status) => {
  await using tmp = await tmpdir()
  using view = await mountAside(tmp.path)
  await view.open()
  await view.app.mockInput.typeText("What was happening?")
  view.app.mockInput.pressEnter()
  await wait(() => view.requests.length === 1)
  view.responses[0].resolve(
    json({
      requestID: "activity",
      text: "An answer from the captured snapshot.",
      snapshot: { capturedAt: 0, excludedMessageCount: 0, activity: { status, tools: [] } },
    }),
  )
  await wait(() => view.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const frame = await view.frame()
  expect(frame).toContain(`Parent activity at capture (not live): ${status}`)
  expect(frame).toContain("Parent tools at capture: none")
  view.app.mockInput.pressEscape()
  await wait(() => view.parent.focused)
  expect(view.cancels).toHaveLength(0)
})
