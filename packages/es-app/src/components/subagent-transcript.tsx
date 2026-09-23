import { createResource, For, onCleanup, onMount, Show } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import { DataProvider } from "@opencode-ai/session-ui/context"
import { TranscriptMessage } from "./transcript-message"
import { Dialog } from "@opencode-ai/ui/dialog"
import { oc } from "../api"
import { createLiveSession } from "../live-session"

export const SubagentTranscript = (props: { sessionID: string; directory: string; onDispose: () => void }) => {
  const controller = new AbortController()
  onCleanup(() => {
    controller.abort()
    props.onDispose()
  })
  const [result, { refetch }] = createResource(async () => {
    return oc.session(props.sessionID, props.directory, controller.signal).then(
      (session) => {
        if (session.id !== props.sessionID || typeof session.directory !== "string" ||
          !/^(\/|[A-Za-z]:[\\/])/.test(session.directory)) {
          return { error: "The subagent session returned invalid identity or directory metadata." }
        }
        return { session }
      },
      () => ({ error: "Unable to load the subagent session.", session: undefined }),
    )
  })
  return (
    <Dialog title={<bdi>{result()?.session?.title || "Subagent transcript"}</bdi>}
      size="x-large" class="subagent-transcript-dialog">
      <Show when={result.loading}><p role="status">Loading subagent…</p></Show>
      <Show when={result()?.error}>{(error) => <div role="alert" class="err">
        {error()} <button disabled={result.loading} onClick={() => void refetch()}>Retry</button>
      </div>}</Show>
      <Show when={result()?.session} keyed>{(session) => <Transcript session={session} />}</Show>
    </Dialog>
  )
}

const Transcript = (props: { session: Session }) => {
  const live = createLiveSession(props.session.id, props.session.directory)
  const messages = () => live.data.message[props.session.id] ?? []
  const valid = () => live.data.session[0]?.id === props.session.id &&
    live.data.session[0]?.directory === props.session.directory
  onMount(() => { void live.load().catch(() => {}) })
  return <>
    <div class="subagent-transcript-meta">
      <span>Read-only inspection</span>
      <span role="status">{live.loading() ? "Loading transcript…" : live.connectionError() ? "Disconnected" :
        live.error() ? "Failed" : live.data.session_status[props.session.id]?.type ?? "idle"}</span>
      <bdi dir="ltr" title={props.session.directory}>{props.session.directory}</bdi>
    </div>
    <Show when={live.connectionError()}>{(error) => <div role="alert" class="err">
      {error()} <button disabled={live.loading()} onClick={() => void live.load().catch(() => {})}>Retry</button>
    </div>}</Show>
    <Show when={live.error()}>{(error) => <div role="alert" class="err">{error()}</div>}</Show>
    <Show when={!live.loading() && !live.connectionError() && !valid()}>
      <div role="alert" class="err">The transcript does not match the requested subagent.</div>
    </Show>
    <div class="transcript subagent-transcript" tabIndex={0} aria-label="Subagent transcript">
      <Show when={valid()}>
        <Show when={!live.loading() && !messages().length}><p role="status">No messages yet.</p></Show>
        <DataProvider data={live.data} directory={props.session.directory} sessionID={props.session.id}>
          <For each={messages()}>{(message) => <TranscriptMessage message={message} parts={live.data.part[message.id] ?? []} />}</For>
        </DataProvider>
      </Show>
    </div>
  </>
}
