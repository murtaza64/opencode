/* Who owns a Surface, in its header (surface-owner-feedback): the lane that published it, resolved on the Surface's
 * own host to that lane's CURRENT owner session (a handoff moves the lane record's owner, so the record is already the
 * current one), and "Published by" when the publishing author is named differently. Message owner opens that session
 * on its own host with the Surface attached to its draft as a context chip; nothing is sent. Without one current
 * owner it says so and offers Ask Front Desk with the same chip; it never guesses a session. */
import { createResource, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useDeskChatOptional } from "../desk-companion"
import { contextKey, MAX_CONTEXT, surfaceRef, type ContextRef } from "../context-mention"
import { sessionHref } from "../state"
import type { Surface } from "../surfaces"
import { surfaceOwner } from "../surface-owner"

/** The context chips a session's draft keeps (same store as the session page's @ chips). */
const chipStore = (host: string | undefined, session: string) => host ? `es-app:context-refs:${host}:${session}` : `es-app:context-refs:${session}`
const addChip = (key: string, ref: ContextRef) => {
  const current = (() => { try { return JSON.parse(localStorage.getItem(key) ?? "[]") as ContextRef[] } catch { return [] } })()
  if (current.some((item) => contextKey(item) === contextKey(ref)) || current.length >= MAX_CONTEXT) return
  try { localStorage.setItem(key, JSON.stringify([...current, ref])) } catch { /* the session opens without the chip */ }
}

export const SurfaceOwner = (props: { surface: Surface; host?: { id: string; label: string } }) => {
  const navigate = useNavigate()
  const desk = useDeskChatOptional()
  const [owner] = createResource(() => props.surface, (surface) => surfaceOwner(surface, props.host ? `/hosts/${props.host.id}` : ""))
  const ref = () => surfaceRef(props.surface, props.host?.id ?? window.location.host)
  const publisher = () => props.surface.owner && props.surface.owner !== props.surface.lane ? props.surface.owner : undefined
  const message = () => {
    const value = owner()
    if (value?.state !== "ok") return
    // A draft already at the chip limit keeps its chips; the session page says so when the next one is added.
    addChip(chipStore(props.host?.id, value.session), ref())
    navigate(props.host ? `/session/${encodeURIComponent(value.session)}?directory=${encodeURIComponent(value.directory)}&host=${encodeURIComponent(props.host.id)}`
      : sessionHref(value.session, value.directory))
  }
  return <span class="surface-owner" data-surface-owner={owner()?.state ?? "loading"}>
    <Show when={props.surface.lane}>{lane => <span class="surface-head-link">Owner: <bdi dir="auto">{lane()}</bdi></span>}</Show>
    <Show when={publisher()}>{name => <span class="surface-head-link">Published by <bdi dir="auto">{name()}</bdi></span>}</Show>
    <Show when={owner()?.state === "ok"} fallback={
      <Show when={owner() && owner()!.state !== "ok"}>
        <span class="surface-head-link" role="status">{(owner() as { why: string }).why}</span>
        <Show when={desk}>{chat => <button type="button" class="surface-head-text" title="Open the Front desk with this Surface in its draft; nothing is sent"
          onClick={() => chat().ask(ref())}>Ask Front Desk</button>}</Show>
      </Show>}>
      <button type="button" class="surface-head-text" title="Open the owning agent's session with this Surface in its draft; nothing is sent" onClick={message}>Message owner</button>
    </Show>
  </span>
}
