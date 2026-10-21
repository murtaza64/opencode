/* Exact permission reply from Home: the same POST /permission/:id/reply contract
 * and once/always/reject choices as the session's permission rail. */
import { createSignal, For, Show } from "solid-js"
import { A } from "@solidjs/router"
import { oc } from "../api"
import { HttpError } from "../api-error"
import { ago, sessionHref } from "../state"
import type { HomeRequestRow } from "../home-requests"

type Reply = "once" | "always" | "reject"
type Outcome = { kind: "sending"; reply: Reply } | { kind: "missing" } | { kind: "uncertain"; at: number } | { kind: "refused"; message: string }
export type HomeReplyReceipt = { key: string; reply: Reply; result: "applied" | "not-applied" | "uncertain"; permission: string; title: string; session: string; directory: string; at: number }

const labels: Record<Reply, string> = { once: "Allow once", always: "Always allow", reject: "Reject" }
// One reply per exact request across every Home card that renders it.
const inflight = new Set<string>()

export const HomePermission = (props: {
  item: HomeRequestRow
  live: "pending" | "cleared" | "unknown"
  // Other pending requests of the same session that a reject or always reply also settles.
  siblings: number
  owner?: string
  stale: boolean
  onReceipt: (receipt: HomeReplyReceipt) => void
  onRecheck: (directory: string) => Promise<void>
}) => {
  const [outcome, setOutcome] = createSignal<Outcome>()
  const key = () => JSON.stringify([props.item.directory, "permission", props.item.id])
  const request = () => props.item.permission
  // Retry is offered again only after a later source check confirms the same request is still pending.
  const recovered = () => {
    const current = outcome()
    return current?.kind !== "uncertain" || props.item.checked > current.at
  }
  const ready = () => !!request() && props.item.state === "pending" && props.live !== "cleared" && outcome()?.kind !== "sending" && outcome()?.kind !== "missing" && recovered()
  const send = async (reply: Reply) => {
    // Snapshot the exact identity: the card may unmount when the reply settles the request.
    const item = props.item
    const id = key()
    if (!ready() || !item.permission || inflight.has(id)) return
    inflight.add(id)
    setOutcome({ kind: "sending", reply })
    const receipt = (result: HomeReplyReceipt["result"]) => props.onReceipt({ key: id, reply, result, permission: item.permission!.permission, title: item.title, session: item.session, directory: item.directory, at: Date.now() })
    const recheck = props.onRecheck
    try {
      await oc.permissionReply(item.id, item.directory, reply)
      setOutcome(undefined)
      receipt("applied")
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) setOutcome({ kind: "missing" })
      else if (error instanceof HttpError && error.status >= 400 && error.status < 500) setOutcome({ kind: "refused", message: error.message })
      else setOutcome({ kind: "uncertain", at: Date.now() })
      receipt(error instanceof HttpError && error.status >= 400 && error.status < 500 ? "not-applied" : "uncertain")
    } finally {
      inflight.delete(id)
      void recheck(item.directory)
    }
  }
  const metadata = () => Object.entries(request()?.metadata ?? {}).flatMap(([name, value]): [string, string][] => {
    if (Array.isArray(value)) {
      const scalars = value.filter(item => item != null && typeof item !== "object")
      return scalars.length ? [[name, scalars.map(String).join("\n")]] : []
    }
    return value == null || typeof value === "object" ? [] : [[name, String(value)]]
  })
  const always = () => request()?.always.filter(Boolean) ?? []
  return <div class="home-request home-permission" data-request-id={props.item.id}>
    <div>
      <span class="home-eyebrow"><span>permission</span><bdi dir="ltr">{request()?.permission ?? "unknown tool"}</bdi></span>
      <h3><bdi dir="auto">{props.item.title}</bdi></h3>
      <Show when={props.owner}><div class="home-muted">Subagent of <bdi dir="auto">{props.owner}</bdi></div></Show>
      <div class="home-source">Exact request <bdi dir="ltr">{props.item.id}</bdi> · session <bdi dir="ltr">{props.item.session}</bdi> · source checked {ago(props.item.checked)}{props.stale ? " · stale" : ""}</div>
    </div>
    <A href={sessionHref(props.item.session, props.item.directory)}>Open thread</A>
    <Show when={request()} fallback={<p class="home-muted">Request details unavailable. Reply from the original session.</p>}>
      <dl class="home-permission-context">
        <Show when={request()!.patterns.length}><dt>Patterns</dt><dd><For each={request()!.patterns}>{pattern => <bdi class="mono" dir="ltr">{pattern}</bdi>}</For></dd></Show>
        <For each={metadata()}>{([name, value]) => <><dt><bdi dir="ltr">{name}</bdi></dt><dd><bdi class="mono" dir="ltr">{value}</bdi></dd></>}</For>
        <dt>Directory</dt><dd><bdi class="mono" dir="ltr">{props.item.directory}</bdi></dd>
      </dl>
      <div class="home-actions" role="group" aria-label={`Reply to permission ${props.item.id}`}>
        <button class="home-primary" disabled={!ready()} onClick={() => void send("once")}>{labels.once}</button>
        <button disabled={!ready()} onClick={() => void send("always")}>{labels.always}</button>
        <button class="home-danger" disabled={!ready()} onClick={() => void send("reject")}>{labels.reject}</button>
      </div>
      <ul class="home-permission-effects home-muted">
        <li>Always allow adds {always().length ? <For each={always()}>{(pattern, index) => <>{index() ? ", " : ""}<bdi class="mono" dir="ltr">{pattern}</bdi></>}</For> : "no reusable pattern"} for this project while the server keeps it loaded{props.siblings ? ` and approves this session's other pending requests those patterns cover` : ""}.</li>
        <Show when={props.siblings}><li>Reject also rejects {props.siblings} other pending request{props.siblings === 1 ? "" : "s"} from this session.</li></Show>
      </ul>
    </Show>
    <p class="home-permission-status" role="status">
      <Show when={outcome()?.kind === "sending"}>Sending {labels[(outcome() as { reply: Reply }).reply].toLowerCase()}…</Show>
      <Show when={outcome()?.kind === "missing"}>Not applied: this request is no longer pending. It was answered elsewhere, rejected with its session, or expired.</Show>
      <Show when={outcome()?.kind === "refused"}>Not applied: the server refused this reply ({(outcome() as { message: string }).message}).</Show>
      <Show when={outcome()?.kind === "uncertain"}>{recovered() ? "The last reply was not confirmed. The request is still pending; you can reply again." : "Outcome uncertain: the server did not confirm the reply. Rechecking before allowing another reply."}</Show>
      <Show when={!outcome() && props.live === "cleared"}>No longer pending. Outcome unknown here; open the thread to check.</Show>
      <Show when={!outcome() && props.live !== "cleared" && props.item.state !== "pending"}>{props.item.state === "unavailable" ? "Source unavailable; replies are disabled until it is checked again." : "No longer pending; outcome unknown."}</Show>
    </p>
  </div>
}
