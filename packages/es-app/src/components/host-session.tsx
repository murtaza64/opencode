/* Another Work host's session, read-only in this window (Slice R). Its record and messages come
 * through the Local listener's /hosts/<id>/oc read routes; it refreshes on that host's session events
 * (coalesced). There is no composer and no interactive part: replying, answering and permissions
 * happen on that host's own tab, opened on the same session. */
import { createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { DataProvider } from "@opencode-ai/session-ui/context"
import type { Session } from "@opencode-ai/sdk/v2"
import type { MessageWithParts } from "../api"
import { coalesced } from "../coalesced"
import { createServerEvents } from "../event-source"
import { hostBase } from "../host-base"
import { hostTabHref } from "../host-feed"
import { host, readHost, type WorkHost } from "../host"
import { TranscriptMessage } from "./transcript-message"
import { HostGlyph } from "./icons"
import { AppHeader } from "./native-header"

const REFRESH_MS = 2000

export const HostSession = (props: { host: string; sessionID: string; directory: string }) => {
  const self = () => host()?.id
  const target = (): WorkHost | undefined => host()?.work.find((item) => item.id === props.host)
  const base = () => (host() ? hostBase(props.host, self()) : undefined)
  const [checkedAt, setCheckedAt] = createSignal<number>()
  const [failure, setFailure] = createSignal<string>()
  const read = async <T,>(path: string) => {
    const response = await fetch(`${base()}${path}?directory=${encodeURIComponent(props.directory)}`, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel()
      throw new Error(response.status === 401 || response.status === 403 ? "sign-in needed" : `unreachable (HTTP ${response.status})`)
    }
    return (await response.json()) as T
  }
  const id = encodeURIComponent(props.sessionID)
  // Last good data stays shown when a later read fails; the failure is shown beside it.
  // The transcript renderer reads session data from its context, as on this host's own session page.
  const [store, setStore] = createStore<Parameters<typeof DataProvider>[0]["data"]>({ session: [], session_status: {}, session_diff: {}, message: {}, part: {} })
  const [view, setView] = createSignal<{ session: Session; messages: MessageWithParts[] }>()
  // Plain async reads, not a resource: the page opens inside a router transition, which would hold a
  // resource's writes back.
  const load = async () => {
    const prefix = base()
    if (!prefix) return
    const [session, messages] = await Promise.all([read<Session>(`/session/${id}`), read<MessageWithParts[]>(`/session/${id}/message`)]).catch((error: Error) => {
      setFailure(error.message)
      return [undefined, undefined]
    })
    if (!session || !messages) return
    setFailure(undefined)
    setCheckedAt(Date.now())
    setStore(reconcile({ session: [session], session_status: {}, session_diff: {}, message: { [session.id]: messages.map((item) => item.info) },
      part: Object.fromEntries(messages.map((item) => [item.info.id, item.parts])) }))
    setView({ session, messages })
  }
  void readHost().then(() => load())
  const changed = coalesced(() => void load(), REFRESH_MS)
  const events = createServerEvents(`/hosts/${props.host}/oc/global/event`, { types: ["message.updated", "message.part.updated", "message.removed", "session.updated", "session.status"] })
  events.onmessage = (message) => {
    const sessionID = (() => {
      try {
        const payload = JSON.parse(message.data)?.payload
        return payload?.properties?.sessionID ?? payload?.properties?.info?.sessionID ?? payload?.properties?.part?.sessionID ?? payload?.properties?.info?.id
      } catch { return undefined }
    })()
    if (sessionID === props.sessionID) changed()
  }
  onCleanup(() => {
    events.close()
    changed.cancel()
  })
  const label = () => target()?.label ?? props.host
  const ownTab = () => target() && hostTabHref(target()!, { id: props.sessionID, directory: props.directory })
  return <main class="session-page host-session" data-host={props.host}>
    <div class="session-main">
      <AppHeader>
        <h1><HostGlyph host={props.host} /> <bdi dir="auto">{view()?.session.title || props.sessionID}</bdi><span class="sr-only">, on {label()}</span></h1>
      </AppHeader>
      <div class="host-session-bar" role="status">
        <span>Read-only, on {label()}{checkedAt() ? ` · checked ${new Date(checkedAt()!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</span>
        <Show when={failure()}><span class="err"> · {label()}: {failure()}</span></Show>
        <Show when={ownTab()}><a class="primary button" href={ownTab()}>Open on {label()} to reply</a></Show>
      </div>
      <Show when={!base() && host()}><p class="err" role="alert">Unknown host.</p></Show>
      <div class="host-session-messages">
        <DataProvider data={store} directory={props.directory} sessionID={props.sessionID}>
          <For each={view()?.messages ?? []}>{(item) => <TranscriptMessage message={item.info} parts={store.part[item.info.id] ?? []} />}</For>
        </DataProvider>
      </div>
    </div>
  </main>
}
