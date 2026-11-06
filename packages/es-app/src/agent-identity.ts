/* One display identity for an agent, keyed by its verified logical owner (project/lane + host) or the Desk
 * pointer, never by a session title or a display label. Primary is always project/lane; an alias is shown only
 * when the persona registry sets one. The session title is the task line; the session id is diagnostic only. */
import { createMemo } from "solid-js"
import { DESK, personas } from "./desk-identity"
import { deskSessionID } from "./desk-session"

export type AgentRef = {
  /** A lane slug or an `editspace/lane` (optionally `host:`-prefixed as the registry stores it). */
  lane?: string | null
  editspace?: string | null
  host?: string | null
  /** The session that owns the work; the Desk pointer is Porter, not the implementation lane. */
  session?: string | null
  /** The session title: displayed as the task, never used as a name. */
  title?: string | null
  /** A recorded owner/lane label (`editspace/lane`), e.g. from a Surface or mail party. */
  owner?: string | null
  name?: string | null
  /** Explicit desk identity (the current Desk session may not be loaded yet). */
  desk?: boolean
}

export type AgentIdentity = { key: string; primary: string; alias?: string; task?: string; role?: string; avatar?: string }

const HOST_PREFIX = /^([a-z][a-z0-9-]*):(.+)$/
const parse = (value: string | null | undefined) => {
  if (!value) return {}
  if (value.startsWith("[")) {
    try {
      const pair: unknown = JSON.parse(value)
      if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string") return { editspace: pair[0], lane: pair[1] }
    } catch { /* not a lane pair */ }
  }
  const host = HOST_PREFIX.exec(value)
  const rest = host ? host[2]! : value
  const slash = rest.indexOf("/")
  return slash > 0
    ? { host: host?.[1], editspace: rest.slice(0, slash), lane: rest.slice(slash + 1) }
    : { host: host?.[1], lane: rest }
}
const normal = (value: string | null | undefined) => value?.replace(/\/+$/, "").toLowerCase()

/** The primary label: project/lane when both are known, else the lane slug. Never the session title. */
export const agentLabel = (identity: AgentIdentity) => identity.alias && identity.alias.toLowerCase() !== identity.primary.toLowerCase()
  ? `${identity.alias} · ${identity.primary}`
  : identity.primary

const identityFrom = (ref: AgentRef, registry: readonly { name: string; owner_lane: string; role?: string; avatar_url?: string }[]): AgentIdentity => {
  const full = ref.owner ?? ref.lane
  const parsed = parse(full)
  // An owner/lane that already names its project wins over a caller's current project (cross-project mail).
  const editspace = (full?.includes("/") ? parsed.editspace : undefined) ?? ref.editspace ?? parsed.editspace
  const lane = ref.lane && !/[\/\[\]:]/.test(ref.lane) ? ref.lane : parsed.lane
  const host = ref.host ?? parsed.host
  const primary = editspace && lane ? `${editspace}/${lane}` : lane ?? ref.name ?? ref.title ?? "Agent"
  // The Desk is Porter only when this is its own pointer session (Work profile); the implementation lane keeps
  // its own project/lane and descriptor.
  if (ref.desk || (ref.session !== undefined && ref.session !== null && ref.session === deskSessionID())) {
    return { key: "desk", primary: "Work Front Desk", alias: DESK.name === "Porter" ? "Porter" : undefined,
      task: ref.title ?? undefined, role: DESK.role, avatar: DESK.avatar }
  }
  const wanted = normal(primary)
  const found = registry.find((item) => normal(item.owner_lane) === wanted || normal(parse(item.owner_lane).lane) === normal(lane) && normal(parse(item.owner_lane).editspace) === normal(editspace))
  // Porter is the Desk pointer, never the opencode/front-desk implementation lane, even though the registry's
  // Porter entry names that lane as its owner.
  const persona = found && lane === "front-desk" && found.name === "Porter" ? undefined : found
  const alias = persona?.name && persona.name.toLowerCase() !== primary.toLowerCase() ? persona.name : undefined
  return {
    key: host ? `${host}:${primary}` : primary,
    primary,
    ...(alias ? { alias } : {}),
    ...(ref.title ? { task: ref.title } : {}),
    ...(persona?.role ?? (lane === "front-desk" ? "front desk implementation" : undefined) ? { role: persona?.role ?? "front desk implementation" } : {}),
    ...(persona?.avatar_url ? { avatar: persona.avatar_url } : {}),
  }
}

export const agentIdentity = (ref: AgentRef): AgentIdentity => identityFrom(ref, personas())

/** Reactive identity for a component; the persona registry is a signal, so an alias arriving later re-renders. */
export const useAgentIdentity = (ref: () => AgentRef) => createMemo(() => agentIdentity(ref()))
