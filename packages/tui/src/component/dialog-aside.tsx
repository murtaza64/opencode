import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, onCleanup, Show } from "solid-js"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { DialogPrompt } from "../ui/dialog-prompt"
import { errorMessage } from "../util/error"

export const DialogAside = (props: {
  sessionID: string
  model?: { providerID: string; modelID: string }
  agent?: string
}) => {
  const sdk = useSDK()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [result, setResult] = createSignal<NonNullable<Awaited<ReturnType<typeof sdk.client.session.aside>>["data"]>>()
  let request: { sessionID: string; requestID: string; controller: AbortController } | undefined

  const cancelRequest = () => {
    if (!request) return
    const pending = request
    request = undefined
    pending.controller.abort()
    // Cancellation must outlive the aborted POST and the dialog's owner.
    void sdk.client.session
      .cancelAside(
        { sessionID: pending.sessionID, requestID: pending.requestID },
        { signal: AbortSignal.timeout(5_000), throwOnError: true },
      )
      .catch(() => {})
  }

  onCleanup(cancelRequest)

  const cancel = () => {
    if (!busy()) return
    cancelRequest()
    setBusy(false)
    setError("Cancellation requested. Server stop is not confirmed.")
  }

  useBindings(() => ({
    mode: "modal",
    priority: 1,
    enabled: busy(),
    bindings: [{ key: "ctrl+g", desc: "Cancel Aside", group: "Dialog", cmd: cancel }],
  }))

  const submit = (input: string) => {
    const question = input.trim()
    if (busy() || !question) return
    const controller = new AbortController()
    const sessionID = props.sessionID
    const requestID = crypto.randomUUID()
    request = { sessionID, requestID, controller }
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    const timer = setTimeout(() => {
      cancelRequest()
      setBusy(false)
      setError("Aside timed out. Cancellation requested; server stop is not confirmed.")
    }, 120_000)
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true })

    void sdk.client.session
      .aside(
        {
          sessionID,
          requestID,
          question,
          model: props.model,
          agent: props.agent,
        },
        { signal: controller.signal, throwOnError: true },
      )
      .then((response) => {
        if (controller.signal.aborted) return
        request = undefined
        setResult(response.data)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        request = undefined
        setError(`Aside failed: ${errorMessage(cause)}`)
      })
      .finally(() => {
        clearTimeout(timer)
        if (controller.signal.aborted) return
        setBusy(false)
      })
  }

  return (
    <scrollbox maxHeight={Math.max(1, Math.floor(dimensions().height * 0.75) - 1)}>
      <DialogPrompt
        title="Aside"
        placeholder="Ask a side question"
        busy={busy()}
        busyText="Asking Aside..."
        onConfirm={submit}
        description={() => (
          <text fg={theme.textMuted}>
            Ephemeral snapshot, not live. Aside uses no tools. The main task keeps running.
          </text>
        )}
      />
      <box paddingX={2} paddingBottom={1} gap={1}>
        <Show when={busy()}>
          <text fg={theme.textMuted} onMouseUp={cancel}>
            ctrl+g cancel Aside
          </text>
        </Show>
        <Show when={error()}>{(message) => <text fg={theme.error}>{message()}</text>}</Show>
        <Show when={result()}>
          {(answer) => (
            <>
              <text fg={theme.textMuted}>
                {`Snapshot: ${new Date(answer().snapshot.capturedAt).toISOString()}\nThrough: ${answer().snapshot.throughMessageID ?? "no completed messages"}\nExcluded messages: ${answer().snapshot.excludedMessageCount}`}
              </text>
              <text fg={theme.textMuted}>
                {`Parent activity at capture (not live): ${answer().snapshot.activity.status}\nParent tools at capture: ${
                  answer()
                    .snapshot.activity.tools.map((tool) => `${tool.name} (${tool.status})`)
                    .join(", ") || "none"
                }`}
              </text>
              <text fg={theme.text}>{answer().text}</text>
            </>
          )}
        </Show>
        <text fg={theme.textMuted}>Close to return to main task. This answer is not sent to it.</text>
      </box>
    </scrollbox>
  )
}
