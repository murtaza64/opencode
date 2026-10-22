import type { Message, RestartContinuation } from "@opencode-ai/sdk/v2"

export type RestartMarker = {
  restartID: string
  state: "resumed" | "resuming" | "uncertain"
  label: string
}

/**
 * Transcript markers for daemon-restart continuations recorded on `anchor`. The server only records
 * what it decided at admission, so "resumed" needs evidence: an assistant message that started at or
 * after the decision. Without it a busy Session is still resuming and an idle one made no observable
 * progress, which is reported as uncertain rather than claimed as resumed.
 */
export function restartMarkers(anchor: Message, messages: readonly Message[], busy: boolean): RestartMarker[] {
  return (anchor.restarts ?? []).map((marker) => ({ restartID: marker.restartID, ...view(marker, anchor, messages, busy) }))
}

const REASONS: Record<NonNullable<RestartContinuation["reason"]>, string> = {
  "interrupted-tool": "a tool may have partly run",
  aborted: "stopped before the restart",
  "out-of-order": "message clock out of order",
}

function view(marker: RestartContinuation, anchor: Message, messages: readonly Message[], busy: boolean) {
  const tools = marker.interruptedTools ? ` · ${marker.interruptedTools} tool${marker.interruptedTools === 1 ? "" : "s"} to check` : ""
  if (marker.outcome === "uncertain")
    return { state: "uncertain" as const, label: `Daemon restart · not resumed: ${REASONS[marker.reason ?? "interrupted-tool"]}${tools}` }
  const resumed = messages.some(
    (message) => message.role === "assistant" && message.id > anchor.id && message.time.created >= marker.time,
  )
  if (resumed) return { state: "resumed" as const, label: `Resumed after daemon restart${tools}` }
  if (busy) return { state: "resuming" as const, label: `Resuming after daemon restart${tools}` }
  return { state: "uncertain" as const, label: `Daemon restart · resume scheduled, no progress observed${tools}` }
}
