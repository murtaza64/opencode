import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionV1InputReceipt } from "@opencode-ai/sdk/v2"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { useSDK } from "../../context/sdk"
import { usePromptRef } from "../../context/prompt"
import { useTheme } from "../../context/theme"
import { useCommandShortcut } from "../../keymap"
import type { PromptInfo } from "../../prompt/history"
import { errorMessage } from "../../util/error"

export type Delivery = "send" | "aside" | "queue" | "steer"
type Buffer = { prompt: PromptInfo; cursor: number; revision: number }
type AsideResult = NonNullable<Awaited<ReturnType<ReturnType<typeof useSDK>["client"]["session"]["aside"]>>["data"]>
const empty = (): Buffer => ({ prompt: { input: "", parts: [] }, cursor: 0, revision: 0 })
const createComposerState = () =>
  createStore({
    mode: "send" as Delivery,
    task: empty(),
    aside: undefined as Buffer | undefined,
    result: undefined as AsideResult | undefined,
    question: "",
    transaction: undefined as
      | { requestID: string; delivery: "queue" | "steer"; text: string; revision: number; uncertain?: boolean }
      | undefined,
    sending: false,
    cleared: 0,
    notice: "",
  })
export type ComposerState = ReturnType<typeof createComposerState>

export const useComposerDelivery = (props: {
  sessionID?: string
  directory?: string
  workspace?: string
  busy: () => boolean
  read: () => { prompt: PromptInfo; cursor: number }
  write: (buffer: { prompt: PromptInfo; cursor: number }) => void
  unsupported: () => string | undefined
}) => {
  const sdk = useSDK()
  const cache = usePromptRef().drafts
  const key = JSON.stringify([sdk.url, props.directory, props.workspace, props.sessionID])
  const cached = cache.get(key) ?? createComposerState()
  cache.set(key, cached)
  const [state, setState] = cached
  const scope = { sessionID: props.sessionID!, directory: props.directory, workspace: props.workspace }
  const [capabilities, setCapabilities] = createSignal<{ aside: boolean; queue: boolean; steer: boolean }>()
  const [rows, setRows] = createSignal<SessionV1InputReceipt[]>([])
  const [listError, setListError] = createSignal("")
  const [asideBusy, setAsideBusy] = createSignal(false)
  const [asideError, setAsideError] = createSignal("")
  let mounted = false
  let restoring = false
  let active: { requestID: string; controller: AbortController } | undefined
  let generation = 0
  let refreshing = false
  let refreshAgain = false

  const save = () => {
    if (!mounted || restoring) return
    const buffer = props.read()
    const name = state.mode === "aside" ? "aside" : "task"
    const previous = state[name]
    const changed = JSON.stringify(previous?.prompt) !== JSON.stringify(buffer.prompt)
    setState(name, { ...buffer, revision: (previous?.revision ?? 0) + Number(changed) })
  }
  const restore = () => {
    if (!mounted) return
    restoring = true
    props.write(state.mode === "aside" ? (state.aside ?? empty()) : state.task)
    restoring = false
  }
  const select = (mode: Delivery) => {
    if (mode === "send" && state.transaction) return
    save()
    if (mode === "aside" && !state.aside) setState("aside", { ...structuredClone(props.read()), revision: 0 })
    setState("mode", mode)
    restore()
  }
  const cycle = () => select(state.mode === "aside" ? "queue" : state.mode === "queue" ? "steer" : "aside")
  const cancelAside = () => {
    if (!active) return
    const request = active
    active = undefined
    request.controller.abort()
    setAsideBusy(false)
    setAsideError("Cancellation requested; server stop is not confirmed.")
    void sdk.client.session
      .cancelAside(
        { ...scope, requestID: request.requestID },
        {
          signal: AbortSignal.timeout(5_000),
          throwOnError: true,
        },
      )
      .catch(() => {})
  }
  const closeAside = () => {
    cancelAside()
    setAsideError("")
    setState("result", undefined)
    if (state.mode === "aside") select("queue")
  }
  const refresh = async () => {
    if (!props.sessionID || (!capabilities()?.queue && !capabilities()?.steer)) return
    if (refreshing) {
      refreshAgain = true
      return
    }
    refreshing = true
    const items: SessionV1InputReceipt[] = []
    let after: string | undefined
    try {
      do {
        const response = await sdk.client.session.input.list(
          { ...scope, state: "pending", limit: "100", after },
          { throwOnError: true, signal: AbortSignal.timeout(10_000) },
        )
        items.push(...response.data.items)
        after = response.data.next == null ? undefined : String(response.data.next)
      } while (after)
      if (!mounted) return
      setRows(items)
      setListError("")
    } catch {
      if (mounted) setListError("Pending inputs unavailable. Refresh to reconcile.")
    } finally {
      refreshing = false
      if (mounted && refreshAgain) {
        refreshAgain = false
        void refresh()
      }
    }
  }
  const discover = async () => {
    const version = ++generation
    setCapabilities(undefined)
    const response = await sdk.client.experimental.capabilities
      .get(
        { directory: props.directory, workspace: props.workspace },
        { throwOnError: true, signal: AbortSignal.timeout(10_000) },
      )
      .catch(() => undefined)
    if (!mounted || version !== generation) return
    const input = response?.data.sessionInput
    setCapabilities({
      aside: response?.data.sessionAside?.version === 1 && response.data.sessionAside.cancel === true,
      queue: input?.version === 1 && input.list && input.cancel && input.delivery.includes("queue"),
      steer: input?.version === 1 && input.list && input.cancel && input.delivery.includes("steer"),
    })
    await refresh()
    if (state.transaction && !state.sending) await reconcile()
  }
  const acknowledge = (receipt: SessionV1InputReceipt) => {
    const transaction = state.transaction
    if (!transaction || receipt.requestID !== transaction.requestID) return
    if (mounted && state.mode !== "aside") save()
    if (state.task.revision === transaction.revision) {
      setState("task", { ...empty(), revision: state.task.revision + 1 })
      setState("cleared", (value) => value + 1)
    }
    setState("transaction", undefined)
    setState("notice", receipt.state === "promoted" ? "Promoted to task, not completed." : `Input ${receipt.state}.`)
    if (mounted) void refresh()
  }
  const reconcile = async () => {
    const transaction = state.transaction
    if (!transaction) return
    const response = await sdk.client.session.input
      .get({ ...scope, requestID: transaction.requestID }, { throwOnError: true, signal: AbortSignal.timeout(10_000) })
      .catch(() => undefined)
    if (response?.data) acknowledge(response.data)
    return !!response?.data
  }
  const blocked = createMemo(() => {
    if (state.mode === "send") return undefined
    if (!capabilities()) return "Checking server support; send disabled."
    if (!capabilities()![state.mode]) return "Server does not support this mode; draft saved."
    return props.unsupported()
  })
  const submit = async (text: string) => {
    if (blocked() || !text.trim() || !props.sessionID) return false
    save()
    if (state.mode === "aside") {
      if (asideBusy()) return false
      const request = { requestID: crypto.randomUUID(), controller: new AbortController() }
      active = request
      setAsideBusy(true)
      setAsideError("")
      setState("result", undefined)
      setState("question", text)
      const timer = setTimeout(cancelAside, 120_000)
      request.controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true })
      void sdk.client.session
        .aside(
          { ...scope, requestID: request.requestID, question: text },
          { signal: request.controller.signal, throwOnError: true },
        )
        .then((response) => {
          if (!request.controller.signal.aborted) setState("result", response.data)
        })
        .catch((cause) => {
          if (!request.controller.signal.aborted)
            setAsideError(`Aside failed: ${errorMessage(cause)}. No automatic retry.`)
        })
        .finally(() => {
          clearTimeout(timer)
          if (active !== request) return
          active = undefined
          setAsideBusy(false)
        })
      return true
    }
    if (state.mode === "send" || state.sending || state.transaction) return false
    setState("transaction", {
      requestID: crypto.randomUUID(),
      delivery: state.mode,
      text,
      revision: state.task.revision,
    })
    await retry()
    return true
  }
  const retry = async () => {
    if (state.sending || !state.transaction || !capabilities()?.[state.transaction.delivery]) return
    setState("sending", true)
    const transaction = state.transaction
    try {
      const response = await sdk.client.session.input.admit(
        {
          ...scope,
          sessionV1InputPayload: {
            requestID: transaction.requestID,
            delivery: transaction.delivery,
            text: transaction.text,
          },
        },
        { throwOnError: false, signal: AbortSignal.timeout(15_000) },
      )
      const status = response.response.status
      if (response.data) {
        acknowledge(response.data)
        return
      }
      const reason = errorMessage(response.error ?? `HTTP ${status} without a receipt`)
      if (!transaction.uncertain && [400, 401, 403, 404, 405, 409, 413, 415, 422].includes(status)) {
        if (state.transaction?.requestID === transaction.requestID) setState("transaction", undefined)
        setState("notice", `Input rejected: ${reason}. Draft saved; edit and send again.`)
        return
      }
      throw new Error(reason)
    } catch (cause) {
      if (state.transaction?.requestID === transaction.requestID)
        setState("transaction", { ...transaction, uncertain: true })
      if (!(await reconcile()) && state.transaction?.requestID === transaction.requestID)
        setState(
          "notice",
          `Acknowledgement unknown: ${errorMessage(cause)}. Check status or retry the same saved input.`,
        )
    } finally {
      setState("sending", false)
    }
  }
  const cancelInput = async (requestID: string) => {
    try {
      await sdk.client.session.input.cancel(
        { ...scope, requestID },
        { throwOnError: true, signal: AbortSignal.timeout(10_000) },
      )
      if (mounted) setState("notice", "Input cancelled.")
    } catch {
      const response = await sdk.client.session.input
        .get({ ...scope, requestID }, { throwOnError: true, signal: AbortSignal.timeout(10_000) })
        .catch(() => undefined)
      if (mounted)
        setState(
          "notice",
          response?.data.state === "promoted"
            ? "Already promoted; cancellation lost the race. Not model-completed."
            : "Cancellation not confirmed. Refresh to reconcile.",
        )
    }
    await refresh()
  }
  onMount(() => {
    mounted = true
    if (props.read().prompt.input || props.read().prompt.parts.length) save()
    else restore()
    void discover()
    const off = sdk.event.on("event", (event) => {
      if (event.payload.type === "server.connected") {
        cancelAside()
        void discover()
        return
      }
      if (event.directory !== props.directory) return
      if (event.payload.type === "session.status" && event.payload.properties.sessionID === props.sessionID)
        void refresh()
    })
    const timer = setInterval(() => void refresh(), 5_000)
    onCleanup(() => {
      off()
      clearInterval(timer)
    })
  })
  createEffect(() => {
    if (props.busy() && untrack(() => state.mode) === "send") untrack(() => select("queue"))
  })
  createEffect(
    on(
      () => state.cleared,
      () => {
        if (mounted && state.mode !== "aside") restore()
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    save()
    cancelAside()
    mounted = false
    generation++
  })
  return {
    state,
    save,
    select,
    cycle,
    submit,
    retry,
    reconcile,
    blocked,
    rows,
    listError,
    refresh,
    cancelInput,
    asideBusy,
    asideError,
    cancelAside,
    closeAside,
  }
}

export const ComposerDelivery = (props: {
  controller: ReturnType<typeof useComposerDelivery>
  busy: boolean
  activate?: () => void
  submit: () => void
  useSessionModel?: () => void
}) => {
  const c = props.controller
  const { theme } = useTheme()
  const renderer = useRenderer()
  const click = (action: () => void) => () => {
    if (renderer.getSelection()?.getSelectedText()) return
    action()
  }
  const dimensions = useTerminalDimensions()
  const shortcut = useCommandShortcut("prompt.delivery.cycle")
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <>
      <Show when={c.state.notice}>
        <text fg={theme.textMuted}>{c.state.notice}</text>
      </Show>
      <Show when={c.state.transaction && !c.state.sending}>
        <box flexDirection="row" gap={2}>
          <text id="composer-reconcile" fg={theme.primary} onMouseUp={click(() => void c.reconcile())}>
            Check status
          </text>
          <text id="composer-retry" fg={theme.primary} onMouseUp={click(() => void c.retry())}>
            Retry same input
          </text>
        </box>
      </Show>
      <Show when={c.rows().length || c.listError()}>
        <text fg={theme.textMuted} onMouseUp={click(() => void c.refresh())}>
          Pending task inputs (click to refresh)
        </text>
        <text fg={theme.warning}>{c.listError()}</text>
        <scrollbox maxHeight={3}>
          <For each={c.rows()}>
            {(row) => (
              <text
                fg={theme.textMuted}
                onMouseUp={click(() => void c.cancelInput(row.requestID))}
              >{`${row.delivery}: ${row.text.slice(0, 60)} [cancel]`}</text>
            )}
          </For>
        </scrollbox>
      </Show>
      <Show when={c.asideBusy() || c.asideError() || c.state.result}>
        <box border={["left"]} borderColor={theme.primary} paddingLeft={1}>
          <box flexDirection="row" gap={2}>
            <text fg={theme.primary}>Aside (not sent to task)</text>
            <text id="aside-close" fg={theme.textMuted} onMouseUp={click(c.closeAside)}>
              {c.asideBusy() ? "Cancel / Close Aside" : "Close Aside"}
            </text>
          </box>
          <Show when={c.asideError()}>
            <text fg={theme.warning}>{c.asideError()}</text>
          </Show>
          <scrollbox maxHeight={Math.max(3, Math.floor(dimensions().height / 4))}>
            <text fg={theme.textMuted}>{`Question: ${c.state.question}`}</text>
            <Show when={c.state.result}>
              {(answer) => (
                <>
                  <text
                    fg={theme.textMuted}
                  >{`Snapshot: ${new Date(Number(answer().snapshot.capturedAt)).toISOString()} (not live)\nAge: ${Math.max(0, Math.floor((now() - Number(answer().snapshot.capturedAt)) / 1000))}s\nThrough: ${answer().snapshot.throughMessageID ?? "no completed messages"}; excluded: ${answer().snapshot.excludedMessageCount}\nParent activity at capture (not live): ${answer().snapshot.activity.status}`}</text>
                  <text fg={theme.text}>{answer().text}</text>
                </>
              )}
            </Show>
          </scrollbox>
        </box>
      </Show>
      <Show when={c.state.mode !== "send" || props.busy}>
        <box flexDirection="row" gap={1} flexWrap="wrap">
          <For each={["aside", "queue", "steer"] as const}>
            {(mode) => (
              <text
                id={`composer-${mode}`}
                fg={c.state.mode === mode ? theme.primary : theme.textMuted}
                onMouseUp={click(() => {
                  props.activate?.()
                  c.select(mode)
                })}
              >
                {c.state.mode === mode
                  ? `[${mode[0].toUpperCase()}${mode.slice(1)}]`
                  : ` ${mode[0].toUpperCase()}${mode.slice(1)} `}
              </text>
            )}
          </For>
          <text fg={theme.textMuted}>{shortcut()} mode</text>
          <Show when={!props.busy && !c.state.transaction}>
            <text id="composer-send" fg={theme.textMuted} onMouseUp={click(() => c.select("send"))}>
              Use normal Send
            </text>
          </Show>
        </box>
        <text fg={theme.textMuted}>
          {c.state.mode === "aside"
            ? "Task draft saved. Snapshot only; no tools. Esc closes Aside."
            : c.state.mode === "queue"
              ? "After task is idle. Uses session agent/model."
              : "At next safe boundary. Uses session agent/model."}
        </text>
        <text minHeight={1} fg={theme.warning}>
          {c.blocked() ?? ""}
        </text>
        <Show when={props.useSessionModel}>
          <text id="composer-session-model" fg={theme.primary} onMouseUp={click(() => props.useSessionModel?.())}>
            Use session model
          </text>
        </Show>
        <text id="composer-submit" fg={c.blocked() ? theme.textMuted : theme.primary} onMouseUp={click(props.submit)}>
          {c.state.mode === "aside"
            ? c.asideBusy()
              ? "Asking Aside..."
              : "Enter: Ask aside"
            : c.state.sending
              ? "Admitting..."
              : c.state.mode === "queue"
                ? "Enter: Queue message"
                : "Enter: Steer task"}
        </text>
      </Show>
    </>
  )
}
