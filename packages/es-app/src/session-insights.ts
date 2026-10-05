/* Per-session insight metadata for the sidebar hover card: exact cost and
 * session model come from the already-loaded session list; completed turn
 * count, latest completed turn usage/model and the estimated composition
 * come from the dashboard's bounded read-only endpoint (dotfiles#139). When
 * that endpoint is not deployed, a bounded tail of the newest messages
 * recovers the latest turn only — turns and composition are reported as
 * unknown rather than guessed. One in-flight request per session, cached by
 * (directory, id, updated) so activity refreshes the card without refetching
 * idle sessions. Never loads a full transcript. */
import { createSignal } from "solid-js"
import { ApiStatusError, es, oc, type SessionInsights } from "./api"
import { latestCompletedTurn, type LatestTurn, type ProviderList } from "./context-usage"
import type { Composition } from "./context-composition"

export type Insights = {
  /** whether the dashboard endpoint served this record (full) or only the message tail did (degraded) */
  source: "dashboard" | "tail" | "none"
  cost: number | null
  sessionModel: string | null
  turns: number | null
  latest: LatestTurn | null
  composition: Composition | null
  error?: string
}

const none = (error: string): Insights => ({ source: "none", cost: null, sessionModel: null, turns: null, latest: null, composition: null, error })

export type InsightsState = { loading: boolean; value: Insights | null }

const TAIL_LIMIT = 6
const UNAVAILABLE_FOR_MS = 10 * 60_000
const CACHE_FOR_MS = 60_000

type Entry = { key: string; at: number; state: () => InsightsState; set: (v: InsightsState) => void; controller?: AbortController }

const entries = new Map<string, Entry>()
let endpointMissingUntil = 0
const sessionKey = (id: string, directory: string) => `${directory}\u0000${id}`

const fromDashboard = (record: SessionInsights): Insights => ({
  source: "dashboard",
  cost: record.cost ?? null,
  sessionModel: record.session_model?.modelID ?? null,
  turns: record.error ? null : record.completed_turns ?? null,
  latest: record.latest ? { providerID: record.latest.model.providerID, modelID: record.latest.model.modelID, tokens: record.latest.tokens } : null,
  composition: record.composition ? {
    basis: record.composition.scope === "since_last_compaction" ? "since_compaction" : "full_history",
    messages: 0,
    chars: {
      user_text: record.composition.user_text,
      assistant_text: record.composition.assistant_text,
      tool_metadata: record.composition.tool_call_metadata,
      tool_output: record.composition.tool_output,
      other: record.composition.other_unattributed,
    },
  } : null,
  error: record.error,
})

const load = async (id: string, directory: string, signal: AbortSignal): Promise<Insights> => {
  if (Date.now() >= endpointMissingUntil) {
    try {
      return fromDashboard(await es.sessionInsights(id, directory, signal))
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof ApiStatusError && error.routeMissing) endpointMissingUntil = Date.now() + UNAVAILABLE_FOR_MS
      else return none("insights unavailable")
    }
  }
  const tail = await oc.messagesTail(id, directory, TAIL_LIMIT, signal).catch((error) => {
    if (signal.aborted) throw error
    return null
  })
  if (!tail) return none("insights unavailable")
  return { source: "tail", cost: null, sessionModel: null, turns: null, latest: latestCompletedTurn(tail.map((m) => m.info)), composition: null }
}

/** Reactive insight state for one session; the fetch starts on first call and
 * is shared by every caller of the same (directory, id, updated). */
export const sessionInsights = (id: string, directory: string, updated: number): (() => InsightsState) => {
  const key = sessionKey(id, directory)
  const version = `${key}\u0000${updated}`
  const existing = entries.get(key)
  if (existing && (existing.key === version || Date.now() - existing.at < CACHE_FOR_MS) && (existing.state().loading || existing.state().value)) {
    return existing.state
  }
  existing?.controller?.abort()
  const [state, set] = createSignal<InsightsState>({ loading: true, value: existing?.state().value ?? null })
  const controller = new AbortController()
  const entry: Entry = { key: version, at: Date.now(), state, set, controller }
  entries.set(key, entry)
  load(id, directory, controller.signal)
    .then((value) => { if (!controller.signal.aborted) set({ loading: false, value }) })
    .catch(() => { if (!controller.signal.aborted) set({ loading: false, value: none("insights unavailable") }) })
  return state
}

/** Abort the in-flight request for a session (pointer left before it answered). */
export const cancelInsights = (id: string, directory: string) => {
  const entry = entries.get(sessionKey(id, directory))
  if (!entry || !entry.state().loading) return
  entry.controller?.abort()
  entries.delete(sessionKey(id, directory))
}

// providers per directory (context limits live on the model record)
const providerCache = new Map<string, Promise<ProviderList>>()
export const providersFor = (directory: string) => {
  let p = providerCache.get(directory)
  if (!p) {
    p = oc.providers(directory).catch(() => ({ providers: [] }))
    providerCache.set(directory, p)
  }
  return p
}

/** test seam: forget cached insights and the endpoint-missing backoff */
export const resetInsightsCache = () => {
  entries.forEach((entry) => entry.controller?.abort())
  entries.clear()
  providerCache.clear()
  endpointMissingUntil = 0
}
