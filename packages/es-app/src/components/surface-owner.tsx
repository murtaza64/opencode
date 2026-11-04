import { createResource, Show } from "solid-js"
import { useNavigate, A } from "@solidjs/router"
import { useDeskChatOptional } from "../desk-companion"
import { contextKey, contextPart, MAX_CONTEXT, surfaceRef, type ContextRef } from "../context-mention"
import { ago, sessionHref } from "../state"
import type { Surface } from "../surfaces"
import { surfaceOwner } from "../surface-owner"
import { personas, DESK } from "../desk-identity"
import { ocAt } from "../api"
import { hostPrefix } from "../host-items"

const chipStore = (host: string | undefined, session: string) => host ? `es-app:context-refs:${host}:${session}` : `es-app:context-refs:${session}`
const addChip = (key: string, ref: ContextRef) => {
  const current = (() => { try { return JSON.parse(localStorage.getItem(key) ?? "[]") as ContextRef[] } catch { return [] } })()
  if (current.some((item) => contextKey(item) === contextKey(ref)) || current.length >= MAX_CONTEXT) return
  try { localStorage.setItem(key, JSON.stringify([...current, ref])) } catch { /* the session opens without the chip */ }
}

/** One owner resolution for the header and the on-Surface composer. Never substitute another session for a missing owner. */
export const useSurfaceOwner = (surface: () => Surface, host?: { id: string; label: string }) => {
  const navigate = useNavigate()
  const [owner] = createResource(surface, value => surfaceOwner(value, host ? hostPrefix(host.id) : ""))
  const ref = () => surfaceRef(surface(), host?.id ?? window.location.host)
  // A persona's name when the lane has one; else the owner as written when it is a name, or the humanised last lane
  // segment ("opencode/ux-feel" -> "Ux feel"), never a raw editspace/lane path.
  const name = () => personas().find(person => person.owner_lane === surface().lane)?.name ?? ownerName(surface())
  const avatar = () => personas().find(person => person.owner_lane === surface().lane || person.name === name())?.avatar_url
  const href = () => {
    const value = owner()
    if (value?.state !== "ok") return undefined
    return host ? `/session/${encodeURIComponent(value.session)}?directory=${encodeURIComponent(value.directory)}&host=${encodeURIComponent(host.id)}`
      : sessionHref(value.session, value.directory)
  }
  const open = () => {
    const value = owner()
    if (value?.state !== "ok") return
    addChip(chipStore(host?.id, value.session), ref())
    navigate(href()!)
  }
  const send = async (text: string, messageID: string) => {
    const value = owner()
    if (value?.state !== "ok") return false
    const core = ocAt(host ? `${hostPrefix(host.id)}/oc` : "/oc")
    const session = await core.session(value.session, value.directory)
    const url = new URL(host ? `/?item=${encodeURIComponent(`${host.id}~surface:${surface().id}`)}` : `/?surface=${encodeURIComponent(surface().id)}`, window.location.origin).href
    await core.prompt(session, value.directory, text, { messageID, context: [contextPart(ref(), url, Date.now())] })
    return true
  }
  return { owner, name, avatar, href, open, send }
}

export const SurfaceOwner = (props: { surface: Surface; host?: { id: string; label: string }; onMessage?: () => void }) => {
  const author = useSurfaceOwner(() => props.surface, props.host)
  const desk = useDeskChatOptional()
  let menu: HTMLDetailsElement | undefined
  const close = () => { if (menu) menu.open = false }
  return <span class="surface-owner" data-surface-owner={author.owner()?.state ?? "loading"}>
    <details class="surface-owner-menu" ref={menu} onKeyDown={event => {
      if (event.key !== "Escape" || !menu?.open) return
      event.preventDefault(); event.stopPropagation(); close(); menu.querySelector("summary")?.focus()
    }}>
      <summary class="surface-owner-chip" title={`Published by ${author.name()}${props.surface.lane ? ` · lane ${props.surface.lane}` : ""}`}>
        <span class="surface-owner-avatar"><Show when={author.avatar()} fallback={author.name().charAt(0).toUpperCase()}>{url => <img src={url()} alt="" referrerpolicy="no-referrer" />}</Show></span>
        <bdi dir="auto">{author.name()}</bdi>
        <Show when={author.owner()?.state === "ok" && (author.owner() as { busy?: boolean }).busy}><span class="dot busy" title="Working" aria-label="Working" /></Show>
      </summary>
      <span class="surface-owner-items">
        <span class="surface-owner-meta">Published {ago(props.surface.created_at ?? props.surface.updated_at)} · rev {props.surface.revision} · {props.host?.label ?? "this host"} · {props.surface.lane ?? "no lane"}
          <Show when={props.surface.requested_in}>{asked => <> · asked in {asked().title ?? "conversation"}</>}</Show>
        </span>
        <Show when={author.owner()?.state === "ok"} fallback={<Show when={author.owner()}>{value => <>
          <span class="surface-owner-meta" role="status">{value().state !== "ok" ? (value() as { why: string }).why : ""}</span>
          <Show when={desk}>{chat => <button type="button" onClick={() => { close(); chat().ask(surfaceRef(props.surface, props.host?.id ?? window.location.host)) }}>Ask {DESK.name}</button>}</Show>
        </>}</Show>}>
          <button type="button" onClick={() => { close(); author.open() }}>Open {author.name()}'s chat</button>
          <button type="button" onClick={() => { close(); props.onMessage?.() }}>Message {author.name()}</button>
        </Show>
        <Show when={props.surface.requested_in}>{asked => <A href={`${sessionHref(asked().session, asked().directory)}${props.host ? `&host=${encodeURIComponent(props.host.id)}` : ""}`} data-requested-in={asked().session} onClick={close}>Open the conversation it was asked in</A>}</Show>
      </span>
    </details>
  </span>
}

const ownerName = (surface: Pick<Surface, "owner" | "lane">) => {
  if (surface.owner && !surface.owner.includes("/")) return surface.owner
  const segment = surface.owner?.split("/").at(-1) || surface.lane
  if (!segment) return "Author"
  const words = segment.replace(/[-_]+/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
