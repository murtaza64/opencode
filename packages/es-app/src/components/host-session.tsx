/* Another Work host's session in this window. Its record and messages come through the Local listener's
 * /hosts/<id>/oc read routes and refresh on that host's session events (coalesced). Sending and steering
 * (Slice W) go to that same host only, as durable input through /hosts/<id>/oc/session/<id>/input with a
 * client request ID, so an unconfirmed send is checked and retried on that host, never elsewhere. Answers,
 * permissions and decisions still happen on that host's own tab. */
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
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

/** A send not yet confirmed: "sending", "accepted" (that host admitted it), "unknown" (check before re-sending),
 * or "absent" (that host has no such input; the person may send the identical request again). */
type Pending = { requestID: string; text: string; state: "sending" | "accepted" | "unknown" | "absent"; acceptedAt?: number }

export const HostSession = (props: { host: string; sessionID: string; directory: string }) => {
  const self = () => host()?.id
  const target = (): WorkHost | undefined => host()?.work.find((item) => item.id === props.host)
  const base = () => (host() ? hostBase(props.host, self()) : undefined)
  const [checkedAt, setCheckedAt] = createSignal<number>()
  const [failure, setFailure] = createSignal<string>()
  const read = async <T,>(path: string) => {
    const response = await fetch(`${base()}${path}?directory=${encodeURIComponent(props.directory)}`, { signal: AbortSignal.timeout(15_000) })
      .catch(() => { throw new Error("unreachable") })
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel()
      throw new Error(response.status === 401 || response.status === 403 ? "sign-in needed" : "unreachable")
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
  // The draft and any unconfirmed send belong to this host and session (host-prefixed storage).
  const draftKey = `host:${props.host}:es-app-host-draft:${props.sessionID}`
  const pendingKey = `host:${props.host}:es-app-host-pending:${props.sessionID}`
  const [draft, setDraft] = createSignal(localStorage.getItem(draftKey) ?? "")
  const saved = (() => { try { return JSON.parse(localStorage.getItem(pendingKey) ?? "null") as Pending | null } catch { return null } })()
  const [pending, setPending] = createSignal<Pending | null>(saved)
  const keep = (value: string) => {
    setDraft(value)
    value ? localStorage.setItem(draftKey, value) : localStorage.removeItem(draftKey)
  }
  const hold = (value: Pending | null) => {
    setPending(value)
    value ? localStorage.setItem(pendingKey, JSON.stringify(value)) : localStorage.removeItem(pendingKey)
  }
  const busy = () => pending()?.state === "sending"
  const [refused, setRefused] = createSignal<string>()
  // What that host accepts, read from that host: no durable input there means no Send here.
  const [canInput, setCanInput] = createSignal<boolean>()
  void readHost().then(async () => {
    const prefix = base()
    if (!prefix) return setCanInput(false)
    const capabilities = await fetch(`${prefix}/experimental/capabilities?directory=${encodeURIComponent(props.directory)}`).then((response) => response.ok ? response.json() : undefined, () => undefined)
    setCanInput(!!capabilities?.sessionInput)
  })
  // Why Send is off, if it is: unknown host, that host unreachable, no input support there, or a send in flight.
  const blockedReason = () =>
    !base() ? "Unknown host." : failure() ? `${label()} is ${failure()}; nothing is sent while it is.` : canInput() === false ? `${label()} does not accept input from here.` : undefined
  const blocked = () => !!blockedReason() || !!pending() || canInput() !== true
  // Sends (or re-sends, with the same message ID) the held text to this host only.
  const send = async (value: Pending) => {
    hold({ ...value, state: "sending" })
    const prefix = base()
    const response = prefix
      ? await fetch(`${prefix}/session/${id}/input?directory=${encodeURIComponent(props.directory)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Steers a running turn at its next safe point, or starts one when idle.
          body: JSON.stringify({ requestID: value.requestID, delivery: "steer", text: value.text }),
          signal: AbortSignal.timeout(30_000),
        }).catch(() => undefined)
      : undefined
    if (response?.ok) {
      hold({ ...value, state: "accepted", acceptedAt: Date.now() })
      void load()
      return
    }
    // A definite refusal keeps the text for editing; anything else is unknown until checked on that host.
    if (response && response.status >= 400 && response.status < 500) {
      hold(null)
      keep(value.text)
      setRefused(response.status === 409 ? "that request ID was already used for different text; nothing new was sent" : response.status === 401 || response.status === 403 ? "sign-in needed" : `not accepted (HTTP ${response.status})`)
      return
    }
    hold({ ...value, state: "unknown" })
  }
  const submit = () => {
    const text = draft().trim()
    if (!text || blocked()) return
    setRefused(undefined)
    keep("")
    void send({ requestID: crypto.randomUUID(), text, state: "sending" })
  }
  // An unknown outcome is settled by reading that input on that host: present = sent; absent = "not received",
  // and only the person's explicit "Send again" re-sends, with the identical request.
  const check = async () => {
    const value = pending()
    if (!value || !base()) return
    const response = await fetch(`${base()}/session/${id}/input/${encodeURIComponent(value.requestID)}?directory=${encodeURIComponent(props.directory)}`).catch(() => undefined)
    if (response?.ok) {
      hold({ ...value, state: "accepted", acceptedAt: Date.now() })
      void load()
      return
    }
    hold({ ...value, state: response?.status === 404 ? "absent" : "unknown" })
  }
  const stop = () => {
    if (!base()) return
    void fetch(`${base()}/session/${id}/abort?directory=${encodeURIComponent(props.directory)}`, { method: "POST" }).catch(() => undefined)
  }
  // Once that host has admitted it and its transcript has been read again, the receipt is done.
  createEffect(() => {
    const value = pending()
    const read = checkedAt()
    if (value?.state === "accepted" && read && read > value.acceptedAt!) hold(null)
  })
  // A send interrupted by a reload is checked once on open.
  if (saved && (saved.state === "sending" || saved.state === "unknown")) queueMicrotask(() => void check())
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
        <span>On {label()}{checkedAt() ? ` · checked ${new Date(checkedAt()!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</span>
        <Show when={failure()}><span class="err"> · {label()}: {failure()}</span></Show>
        <Show when={ownTab()}><a class="button" href={ownTab()}>Open on {label()} for answers and permissions</a></Show>
      </div>
      <Show when={!base() && host()}><p class="err" role="alert">Unknown host.</p></Show>
      <div class="host-session-messages">
        <DataProvider data={store} directory={props.directory} sessionID={props.sessionID}>
          <For each={view()?.messages ?? []}>{(item) => <TranscriptMessage message={item.info} parts={store.part[item.info.id] ?? []} />}</For>
        </DataProvider>
      </div>
      <form class="prompt-box host-session-composer" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <Show when={pending()}>{(value) => <p class="host-session-receipt" role="status" data-state={value().state}>
          {value().state === "sending" ? `Sending to ${label()}…` : value().state === "accepted" ? `Sent to ${label()}`
            : value().state === "absent" ? `${label()} did not receive it.` : `Not confirmed by ${label()}.`}
          <Show when={value().state === "unknown"}> <button type="button" onClick={() => void check()}>Check again</button></Show>
          <Show when={value().state === "absent"}> <button type="button" onClick={() => void send(value())}>Send again</button> <button type="button" onClick={() => { keep(value().text); hold(null) }}>Edit</button></Show>
        </p>}</Show>
        <Show when={refused()}><p class="err" role="alert">{label()}: {refused()}</p></Show>
        <Show when={blockedReason()}><p class="host-session-blocked" role="status">{blockedReason()}</p></Show>
        {/* Provenance: the message is written on that host as sent from this computer's window. */}
        <p class="host-session-provenance dim">From {host()?.label ?? "this computer"} to {label()}</p>
        <textarea aria-label={`Message to ${label()}`} dir="auto" value={draft()} readOnly={busy()} disabled={!base()}
          onInput={(event) => keep(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); submit() } }} />
        <div class="host-session-actions">
          <button type="button" onClick={stop} disabled={!base() || !!failure()}>Stop</button>
          <button type="submit" class="primary" disabled={!draft().trim() || blocked()}>Send to {label()} <kbd aria-hidden="true">⌘/Ctrl↵</kbd></button>
        </div>
      </form>
    </div>
  </main>
}
