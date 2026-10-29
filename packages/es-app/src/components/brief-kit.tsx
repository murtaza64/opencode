/* The parts every brief is built from, so each section reads the same: a copyable exact value, a value the request
 * does not give (shown as missing, never filled in), a short link name and evidence refs. Styles: pages/brief.css. */
import { createSignal, For, Show } from "solid-js"
import { A } from "@solidjs/router"
import { sessionHref } from "../state"
import type { DeskItem, EvidenceRef } from "../desk"

/** What any brief shows for a value the request does not state. */
export const MISSING = "Not given in the request"

/** A value from the request, or the missing marker when it is empty. */
export const Value = (props: { value: string; dir?: "auto" | "ltr" }) =>
  <Show when={props.value} fallback={<span class="brief-missing">{MISSING}</span>}><span dir={props.dir ?? "auto"}>{props.value}</span></Show>

export const Refs = (props: { refs: string[]; known: EvidenceRef[]; item: DeskItem; host?: string }) =>
  <For each={props.refs}>{id => {
    const ref = () => props.known.find(candidate => candidate.id === id)
    return <Show when={ref()?.messageID} fallback={<span class="desk-ref" title={ref()?.label}>{id}</span>}>
      <A class="desk-ref" title={ref()?.label} href={sessionHref(props.item.source.session, props.item.source.directory) + (props.host ? `&host=${encodeURIComponent(props.host)}` : "")}>{id}</A>
    </Show>
  }}</For>

/** A short name for a link: owner/repo#123 becomes repo#123; otherwise the host. */
export const linkName = (url: string) => {
  const parsed = new URL(url)
  const pull = /^\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/.exec(parsed.pathname)
  if (parsed.hostname === "github.com" && pull) return `${pull[1]}#${pull[2]}`
  return parsed.hostname.endsWith(".slack.com") ? "Slack" : parsed.hostname
}

// An exact value to copy (a command, a setting). Display only: nothing here runs or applies anything.
export const CopyCode = (props: { text: string; inline?: boolean }) => {
  const [copied, setCopied] = createSignal<"Copied" | "Copy failed">()
  const copy = async () => {
    const ok = await navigator.clipboard?.writeText(props.text).then(() => true, () => false) || copyBySelection(props.text)
    setCopied(ok ? "Copied" : "Copy failed")
    setTimeout(() => setCopied(), 2000)
  }
  // A short value sits in the text flow; a command keeps its own scrolling block.
  if (props.inline) return <span class="desk-command desk-command-inline"><code dir="ltr">{props.text}</code>
    <button type="button" class="desk-command-copy" aria-label="Copy value" onClick={() => void copy()}>{copied() ?? "Copy"}</button></span>
  return <div class="desk-command"><pre dir="ltr"><code>{props.text}</code></pre>
    <button type="button" class="desk-command-copy" aria-label="Copy command" onClick={() => void copy()}>{copied() ?? "Copy"}</button></div>
}

// The async Clipboard API is unavailable outside secure contexts; a selection copy inside the click still works.
const copyBySelection = (text: string) => {
  const input = document.createElement("textarea")
  input.value = text
  input.readOnly = true
  input.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0"
  document.body.append(input)
  try { input.select(); return document.execCommand("copy") } catch { return false } finally { input.remove() }
}
