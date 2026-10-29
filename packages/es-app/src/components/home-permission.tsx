/* Exact permission reply from Home: the same POST /permission/:id/reply contract
 * and once/always/reject choices as the session's permission rail. */
import { createSignal, For, onCleanup, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { A } from "@solidjs/router"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { resolveFileDiff } from "@opencode-ai/session-ui/session-diff"
import { oc } from "../api"
import { HttpError } from "../api-error"
import { ago, sessionHref } from "../state"
import { editFiles, type EditFile, type HomeRequestRow, type requestLive } from "../home-requests"
import { Glyph } from "./icons"
import { LinkedText } from "./linked-text"

type Reply = "once" | "always" | "reject"
type Outcome = { kind: "sending"; reply: Reply } | { kind: "applied"; reply: Reply } | { kind: "missing" } | { kind: "uncertain"; at: number } | { kind: "refused"; message: string }
export type HomeReplyReceipt = { key: string; reply: Reply; result: "applied" | "not-applied" | "uncertain"; permission: string; title: string; session: string; directory: string; at: number }
/** pending: verified waiting. cleared: verified no longer waiting (answered or withdrawn, outcome not known here).
 * unavailable: the source could not be checked. unknown: not verified either way. */
export type PermissionLive = ReturnType<typeof requestLive>

const labels: Record<Reply, string> = { once: "Allow once", always: "Always allow", reject: "Reject" }
const done: Record<Reply, string> = { once: "Allowed once", always: "Always allowed", reject: "Rejected" }
// Metadata the edit layout already shows as the path header and the rendered diff.
const EDIT_FIELDS = new Set(["filepath", "diff", "files"])
// Larger diffs start folded so the next file and the page stay reachable.
const OPEN_LINES = 400
// One reply per exact request across every Home card that renders it.
const inflight = new Set<string>()

export const HomePermission = (props: {
  item: HomeRequestRow
  live: PermissionLive
  // Other pending requests of the same session that a reject or always reply also settles.
  siblings: number
  owner?: string
  stale: boolean
  onReceipt: (receipt: HomeReplyReceipt) => void
  onRecheck: (directory: string) => Promise<void>
  /** Another Work host's Core (host-items.ts `hostCore`): the reply goes to that host. Default: this page's. */
  core?: Pick<typeof oc, "permissionReply">
}) => {
  const [outcome, setOutcome] = createSignal<Outcome>()
  const [checking, setChecking] = createSignal(false)
  const key = () => JSON.stringify([props.item.directory, "permission", props.item.id])
  const request = () => props.item.permission
  // Retry is offered again only after a later source check confirms the same request is still pending.
  const recovered = () => {
    const current = outcome()
    return current?.kind !== "uncertain" || props.item.checked > current.at
  }
  const waiting = () => props.item.state === "pending" && props.live === "pending"
  const settled = () => ["applied", "missing"].includes(outcome()?.kind ?? "")
  // Controls exist only for a request verified as waiting; stale or unverified requests show their state instead.
  const actionable = () => !!request() && waiting() && !settled()
  const ready = () => actionable() && outcome()?.kind !== "sending" && recovered()
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
      await (props.core ?? oc).permissionReply(item.id, item.directory, reply)
      setOutcome({ kind: "applied", reply })
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
  const recheck = () => {
    setChecking(true)
    void props.onRecheck(props.item.directory).finally(() => setChecking(false))
  }
  const files = () => editFiles(request())
  const metadata = () => Object.entries(request()?.metadata ?? {}).flatMap(([name, value]): [string, string][] => {
    if (files().length && EDIT_FIELDS.has(name)) return []
    if (Array.isArray(value)) {
      const scalars = value.filter(item => item != null && typeof item !== "object")
      return scalars.length ? [[name, scalars.map(String).join("\n")]] : []
    }
    return value == null || typeof value === "object" ? [] : [[name, String(value)]]
  })
  const always = () => request()?.always.filter(Boolean) ?? []
  // Patterns that only repeat a shown value (the command, or the edited paths) add no information.
  const patterns = () => {
    const values = request()?.patterns ?? []
    if (files().length) return []
    return metadata().some(([, value]) => value === values.join("\n")) ? [] : values
  }
  const context = () => <dl class="home-permission-context">
    <Show when={patterns().length}><dt>Patterns</dt><dd><For each={patterns()}>{pattern => <bdi class="mono" dir="ltr">{pattern}</bdi>}</For></dd></Show>
    <For each={metadata()}>{([name, value]) => <><dt><bdi dir="ltr">{name}</bdi></dt><dd><bdi class="mono" dir="ltr"><LinkedText text={value} /></bdi></dd></>}</For>
    <dt>Directory</dt><dd><bdi class="mono" dir="ltr">{props.item.directory}</bdi></dd>
  </dl>
  const status = () => {
    const current = outcome()
    if (current?.kind === "sending") return `Sending ${labels[current.reply].toLowerCase()}…`
    if (current?.kind === "applied") return `${done[current.reply]} from here.`
    if (current?.kind === "missing") return "Not applied: the agent was no longer waiting on this request."
    if (current?.kind === "refused") return `Not applied: the server refused this reply (${current.message}).`
    if (current?.kind === "uncertain") return recovered() ? "Reply not confirmed; still pending. You can reply again." : "Reply not confirmed; rechecking before another reply."
    return ""
  }
  return <div class="home-request home-permission" data-request-id={props.item.id} data-live={props.item.state === "unavailable" ? "unavailable" : props.live}>
    <div>
      <span class="home-eyebrow"><span><Glyph name="shield" /><bdi dir="ltr">{request()?.permission ?? "unknown tool"}</bdi></span></span>
      <h3><bdi dir="auto">{props.item.title}</bdi></h3>
      <Show when={props.owner}><div class="home-muted">Subagent of <bdi dir="auto">{props.owner}</bdi></div></Show>
      <Show when={props.stale && waiting()}><div class="home-source home-blocked">Last checked {ago(props.item.checked)}</div></Show>
    </div>
    <A href={sessionHref(props.item.session, props.item.directory)}>Open thread</A>
    {/* A request that is not verified as waiting says so first, with what to do next. */}
    <Show when={!waiting() && !settled()}>
      <div class="home-permission-state" role="status">
        <Show when={props.item.state === "unavailable" || props.live === "unavailable"} fallback={
          <Show when={props.live === "cleared" || props.item.state === "unknown"} fallback={<>
            <b>Status unknown.</b> This view can't confirm the agent is still waiting. <button class="desk-button" disabled={checking()} onClick={recheck}>{checking() ? "Checking…" : "Check again"}</button>
          </>}>
            <b>No longer waiting for you.</b> It was answered or withdrawn elsewhere; <A href={sessionHref(props.item.session, props.item.directory)}>open the thread</A> to see which.
          </Show>}>
          <b>Can't reach this project.</b> Replies are paused until the request is checked again. <button class="desk-button" disabled={checking()} onClick={recheck}>{checking() ? "Checking…" : "Check again"}</button>
        </Show>
      </div>
    </Show>
    <Show when={request()} fallback={<p class="home-muted">Request details unavailable. Reply from the original session.</p>}>
      <Show when={files().length} fallback={context()}>
        <ul class="home-edit-files" aria-label="Files to change">
          <For each={files()}>{file => <li>
            <EditPath path={file.path} full={file.full} />
            <Show when={file.movePath && file.full}>{from => <span class="home-source">from <bdi class="mono" dir="ltr">{from()}</bdi></span>}</Show>
            <Show when={file.type === "add" || file.type === "delete" || file.type === "move"}><span class="home-edit-type">{file.type === "add" ? "new file" : file.type === "delete" ? "delete" : "move"}</span></Show>
            <span class="home-edit-counts"><span class="home-edit-add">+{file.additions}</span> <span class="home-edit-del">−{file.deletions}</span></span>
          </li>}</For>
        </ul>
      </Show>
      <Show when={actionable()}>
        <div class="home-actions" role="group" aria-label={`Reply to permission ${props.item.id}`}>
          <button class="home-primary" disabled={!ready()} onClick={() => void send("once")}>{labels.once}</button>
          <button disabled={!ready()} onClick={() => void send("always")}>{labels.always}</button>
          <button class="home-danger" disabled={!ready()} onClick={() => void send("reject")}>{labels.reject}</button>
        </div>
        <ul class="home-permission-effects home-muted">
          <li>Always allow: {always().length ? <For each={always()}>{(pattern, index) => <>{index() ? ", " : ""}<bdi class="mono" dir="ltr">{pattern}</bdi></>}</For> : "nothing reusable"} in this project, not saved across restarts{props.siblings ? `, including matching requests already waiting here` : ""}.</li>
          <Show when={props.siblings}><li>Reject also rejects {props.siblings} other waiting request{props.siblings === 1 ? "" : "s"} from this agent.</li></Show>
        </ul>
      </Show>
      <p class="home-permission-status" role="status">{status()}</p>
      <Show when={files().length}>
        <div class="home-edit-diffs">
          <For each={files()}>{file => <EditDiff file={file} open={files().length <= 3 && file.additions + file.deletions <= OPEN_LINES} />}</For>
        </div>
        <details class="home-permission-more"><summary>Details</summary>{context()}</details>
      </Show>
    </Show>
  </div>
}

// Basename leads; the directory stays visible but quieter, and the full path is on hover.
const EditPath = (props: { path: string; full?: string }) => {
  const slash = () => props.path.lastIndexOf("/")
  return <bdi class="home-edit-path mono" dir="ltr" title={props.full ?? props.path}>
    <Show when={slash() >= 0}><span class="home-edit-dir">{props.path.slice(0, slash() + 1)}</span></Show><b>{props.path.slice(slash() + 1)}</b>
  </bdi>
}

const EditDiff = (props: { file: EditFile; open: boolean }) => {
  const fileComponent = useFileComponent()
  const diff = () => {
    if (!props.file.additions && !props.file.deletions) return
    try {
      return resolveFileDiff({ file: props.file.path, patch: props.file.patch })
    } catch {
      return
    }
  }
  // Side by side once the pane has room (the desk's landscape width); unified below it.
  const [split, setSplit] = createSignal(false)
  const measure = (el: HTMLElement) => {
    const observer = new ResizeObserver(() => setSplit(el.getBoundingClientRect().width >= 1060))
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  }
  return <details ref={measure} class="home-edit-diff" open={props.open} dir="ltr">
    <summary><EditPath path={props.file.path} full={props.file.full} /> <span class="home-edit-counts"><span class="home-edit-add">+{props.file.additions}</span> <span class="home-edit-del">−{props.file.deletions}</span></span></summary>
    <Show when={props.file.additions || props.file.deletions} fallback={<p class="home-muted">No line changes{props.file.type === "add" ? " (empty new file)" : ""}.</p>}>
      <Show when={diff()} fallback={<pre class="home-edit-raw">{props.file.patch}</pre>}>{value =>
        <Show when={split() ? "split" : "unified"} keyed>{style =>
          <Dynamic component={fileComponent} mode="diff" diffStyle={style} fileDiff={value()} hunkSeparators={value().isPartial ? "simple" : "line-info-basic"} />}</Show>}</Show>
    </Show>
  </details>
}
