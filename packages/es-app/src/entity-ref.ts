import type { AttentionRecord } from "./attention"
import type { ContextRef } from "./context-mention"
import type { Surface } from "./surfaces"
import { exactTime, shortDateTime } from "./local-time"

// Entity references (chip design r4, DD #364/#371): one shared shape for a Surface, decision, agent or session named in
// running text, mail rows, snippets and the composer. A reference is resolved only from stores the app already holds
// (the Surface list, the attention snapshot, this editspace's lanes, the persona registry); a name in untrusted text is
// never authority, and an unresolved one stays plain text. The view shows the CURRENT projection (title, state) and
// keeps what the reference was written against (its revision) so a changed item reads as changed; current state is
// never proof that anything was executed.

/** A resolved reference. Extends the composer's ContextRef identity (kind, id, host) with what the text said. */
export type EntityRef = {
  kind: "surface" | "decision" | "agent" | "session"
  id: string
  /** This window's host (location.host) or another Work host's ID. */
  host: string
  /** The revision the reference was written against, when the link says (?rev=). */
  revision?: number
  /** What the text called it, used when the store has no title. */
  label?: string
  /** A declared section anchor id (?section= / #id); never inferred from prose. */
  section?: string
  /** Decisions: the editspace the record lives in. */
  editspace?: string
}

export type Persona = { name: string; owner_lane: string; avatar_url?: string }
export type EntityStores = {
  /** This window's host. */
  here: string
  surfaces: readonly Surface[]
  decisions: readonly AttentionRecord[]
  lanes: readonly { editspace: string; lane: string; owner?: string; status?: string; activity?: string; title?: string }[]
  personas: readonly Persona[]
  /** A Work host's label for an ID. */
  hostLabel?: (host: string) => string | undefined
}

export type EntityState = "ok" | "stale" | "missing" | "elsewhere"
export type EntityView = {
  ref: EntityRef
  title: string
  state: EntityState
  /** Another host's label, when the item lives there. */
  host?: string
  decision?: { status: string; answer?: string }
  avatar?: { url?: string; initials: string }
  /** A mention of the person reading. */
  me?: boolean
  section?: string
  href?: string
  /** Accessible name: kind, title, state words. */
  label: string
  /** The card's rows: label, value. */
  rows: [string, string][]
  preview?: string
}

const initials = (name: string) => name.split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("") || "?"

/** A query-only link ("?item=…") means the app root, not the page it appears on. */
export const rootRelative = (href: string) => href.startsWith("?") ? `/${href}` : href

/** A link to a Surface or decision, as written in text (`/?surface=`, `/__es/surface/`, `/?item=[<host>~]attention:…`,
 * `/?item=[<host>~]surface:<id>`, or the same with no leading slash). */
export const parseEntityHref = (href: string, here: string): EntityRef | undefined => {
  const url = (() => { try { return new URL(rootRelative(href), `https://${here}`) } catch { return undefined } })()
  if (!url) return undefined
  // A Work host's route (/hosts/<id>/...) names that host.
  const routed = /^\/hosts\/([\w-]+)\//.exec(url.pathname)?.[1]
  const host = routed ?? (url.host === here ? here : url.host)
  const revision = Number(url.searchParams.get("rev")) || undefined
  const section = url.searchParams.get("section") ?? (url.hash.length > 1 ? decodeURIComponent(url.hash.slice(1)) : undefined)
  const surface = url.searchParams.get("surface") ?? /\/__es\/surface\/([a-z0-9][a-z0-9-]{0,39})(?:\/|$)/.exec(url.pathname)?.[1]
  if (surface && /^[a-z0-9][a-z0-9-]{0,39}$/.test(surface)) return { kind: "surface", id: surface, host, ...(revision ? { revision } : {}), ...(section ? { section } : {}) }
  const item = url.searchParams.get("item")
  const hosted = item && /^(?:([\w-]+)~)?surface:([a-z0-9][a-z0-9-]{0,39})$/.exec(item)
  if (hosted) return { kind: "surface", id: hosted[2]!, host: hosted[1] ?? host, ...(revision ? { revision } : {}), ...(section ? { section } : {}) }
  const decision = item && /^(?:([\w-]+)~)?attention:([^:]+):(.+)$/.exec(item)
  if (decision) return { kind: "decision", id: decision[3]!, editspace: decision[2]!, host: decision[1] ?? host }
  return undefined
}

/** An `@name` in text, only when it is a known lane of this editspace or a registered persona. */
export const mentionRef = (name: string, stores: Pick<EntityStores, "here" | "lanes" | "personas">): EntityRef | undefined => {
  const persona = stores.personas.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
  if (persona) {
    const [where, lane] = persona.owner_lane.includes("/") ? [persona.owner_lane.slice(0, persona.owner_lane.lastIndexOf("/")), persona.owner_lane.slice(persona.owner_lane.lastIndexOf("/") + 1)] : ["", persona.owner_lane]
    const host = where.includes(":") ? where.split(":")[0]! : stores.here
    return { kind: "agent", id: lane, host, label: persona.name, editspace: where.split(":").at(-1) }
  }
  const lane = stores.lanes.find((entry) => entry.lane === name)
  return lane ? { kind: "agent", id: lane.lane, host: stores.here, editspace: lane.editspace } : undefined
}

/** The composer's chips are the same identities. */
export const entityFromContext = (ref: ContextRef): EntityRef => ref.kind === "agent"
  ? { kind: "agent", id: ref.lane, host: ref.host, label: ref.label, editspace: ref.editspace }
  : ref.kind === "decision" ? { kind: "decision", id: ref.id, host: ref.host, label: ref.label, editspace: ref.editspace, revision: ref.revision }
  : ref.kind === "surface" ? { kind: "surface", id: ref.id, host: ref.host, label: ref.label, revision: ref.revision }
  : { kind: "session", id: ref.id, host: ref.host, label: ref.label }

const DECISION_WORD: Record<string, string> = { open: "open decision", snoozed: "snoozed", answered: "answered", resolved: "resolved", withdrawn: "withdrawn" }

/** The current projection of a reference from the held stores. */
export const entityView = (ref: EntityRef, stores: EntityStores): EntityView => {
  const elsewhere = ref.host !== stores.here
  const hostName = elsewhere ? stores.hostLabel?.(ref.host) ?? ref.host : undefined
  if (ref.kind === "surface") {
    const surface = elsewhere ? undefined : stores.surfaces.find((item) => item.id === ref.id)
    const title = surface?.title ?? ref.label ?? ref.id
    const state: EntityState = elsewhere ? "elsewhere" : !surface ? "missing" : ref.revision !== undefined && surface.revision > ref.revision ? "stale" : "ok"
    const words = state === "missing" ? "not found on this host" : state === "stale" ? `changed since mentioned (was rev ${ref.revision})` : state === "elsewhere" ? `on ${hostName}` : ""
    return { ref, title, state, host: hostName, section: ref.section,
      // Another Work host's Surface opens in the desk reader through that host's key.
      href: elsewhere ? `/?item=${encodeURIComponent(`${ref.host}~surface:${ref.id}`)}` : `/?surface=${encodeURIComponent(ref.id)}`,
      label: [`Surface: ${title}`, ref.section && `section ${ref.section}`, surface && `revision ${surface.revision}`, words].filter(Boolean).join(", "),
      rows: surface ? [["Revision", `rev ${surface.revision} · updated ${shortDateTime(surface.updated_at)}`], ["Owner", surface.owner], ["Host", "this host"],
        ...(ref.section ? [["Section", ref.section] as [string, string]] : []), ...(state === "stale" ? [["Mentioned", `rev ${ref.revision}`] as [string, string]] : [])]
        : [["Host", hostName ?? "this host"], ["State", elsewhere ? `not loaded from ${hostName}` : "not found on this host"]],
      preview: surface?.summary ?? undefined }
  }
  if (ref.kind === "decision") {
    const record = elsewhere ? undefined : stores.decisions.find((item) => item.id === ref.id && (!ref.editspace || item.editspace === ref.editspace))
    const title = record?.title ?? ref.label ?? "decision"
    const answer = record?.answer?.choice_id ? record.options.find((option) => option.id === record.answer!.choice_id)?.label ?? record.answer.choice_id : undefined
    const status = record?.status ?? "unknown"
    const state: EntityState = elsewhere ? "elsewhere" : record ? "ok" : "missing"
    return { ref, title, state, host: hostName, decision: record ? { status, ...(answer ? { answer } : {}) } : undefined,
      href: `/?item=${encodeURIComponent(`${elsewhere ? `${ref.host}~` : ""}attention:${record?.editspace ?? ref.editspace ?? ""}:${ref.id}`)}`,
      label: `Decision: ${title}, ${record ? `${DECISION_WORD[status] ?? status}${answer ? `: ${answer}` : ""}` : elsewhere ? `on ${hostName}` : "not found on this host"}`,
      rows: record ? [["State", `${DECISION_WORD[status] ?? status}${answer ? ` · ${answer}` : ""}`], ["Updated", shortDateTime(record.updated_at)], ...(record.lane ? [["Lane", record.lane] as [string, string]] : [])]
        : [["Host", hostName ?? "this host"], ["State", elsewhere ? `not loaded from ${hostName}` : "not found on this host"]],
      preview: record?.context?.slice(0, 160) }
  }
  if (ref.kind === "agent") {
    const persona = stores.personas.find((entry) => entry.owner_lane.endsWith(`/${ref.id}`) && (!ref.editspace || entry.owner_lane.endsWith(`${ref.editspace}/${ref.id}`)))
    const lane = elsewhere ? undefined : stores.lanes.find((entry) => entry.lane === ref.id)
    const title = persona?.name ?? ref.label ?? ref.id
    return { ref, title, state: elsewhere ? "elsewhere" : lane || persona ? "ok" : "missing", host: hostName,
      avatar: { ...(persona?.avatar_url && /^https:\/\//.test(persona.avatar_url) ? { url: persona.avatar_url } : {}), initials: initials(title) },
      label: `Mention: ${title}, lane ${ref.id}${hostName ? `, on ${hostName}` : ""}`,
      rows: [["Lane", ref.id], ["Host", hostName ?? "this host"], ...(lane?.activity ? [["Now", lane.activity] as [string, string]] : []), ...(lane?.title ? [["Session", lane.title] as [string, string]] : [])] }
  }
  return { ref, title: ref.label ?? ref.id, state: elsewhere ? "elsewhere" : "ok", host: hostName, label: `Session: ${ref.label ?? ref.id}`, rows: [["Session", ref.id], ["Host", hostName ?? "this host"]] }
}

/** Hover text for a time shown in a card. */
export const cardTime = exactTime
