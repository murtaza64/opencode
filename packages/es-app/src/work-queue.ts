/* One Work queue for the unified navigation: this host's desk items (decisions, permissions, questions,
 * failures) and every other Work host's open decisions and pending requests, each entry qualified by its
 * host so equal IDs on two hosts stay two entries; and one Surface list the same way. Reuses existing
 * reads only: the desk queue, this host's Surface list and the Work view host feeds. Every entry opens in
 * this window's Work view (`/?item=<key>`); its detail reads and its actions go through the Local
 * listener's /hosts/<id>/ routes, so they execute on the owning host without switching to that host's tab
 * (host-items.ts). A host whose list is not current makes the count partial ("N+") and is named, never
 * counted as zero. Personal hosts are not Work feeds (`workFeedHosts`) and never appear. */
import type { DeskItem } from "./desk"
import type { AttentionRecord } from "./attention"
import type { HomeRequestRow } from "./home-requests"
import type { HostFeed, ReachReason } from "./host-feed"
import { surfaceKey, type Surface } from "./surfaces"

/** What an entry of another host carries for its detail and actions on that host. */
export type RemoteRef =
  | { kind: "attention"; record: AttentionRecord }
  | { kind: "request"; request: HomeRequestRow }
  /** `frame`: "host" frames through the owning host; "own-host-only" (URL Surfaces) cannot be framed from another
   * computer yet and answers 502 there. */
  | { kind: "surface"; surface: Surface; frame: "host" | "own-host-only" }

export type WorkEntry = {
  /** Unique across hosts: this host's key, or `<host>~<key>` for another host (`parseWorkKey`). */
  key: string
  /** Undefined for this host. */
  host?: string
  hostLabel?: string
  kind: DeskItem["kind"] | "surface"
  title: string
  project?: string
  /** When the source says it was created or last changed; absent when it does not say. */
  created?: number
  updated?: number
  /** Opens in this window's Work view; never another host's origin. */
  href: string
  /** That host is unreachable or this list is not current: this is its last-known entry. */
  stale: boolean
  /** Why that host is unavailable, while it is. */
  unavailableReason?: ReachReason
  /** This host's desk item, when the entry is local (for rows that need the full item). */
  item?: DeskItem
  /** This host's Surface, when the entry is a local Surface. */
  surface?: Surface
  /** Another host's source record, for its in-Work detail and actions on that host. */
  remote?: RemoteRef
}

/** One Work host's list state, for the offline marker and the "N+" count. */
export type WorkHostStatus = {
  id: string
  label: string
  status: "loading" | "ready" | "unavailable"
  reason?: ReachReason
  since?: number
  checkedAt?: number
  /** Its entries in this list are last-known (unreachable, or this list's read failed). */
  partial: boolean
}

export type WorkQueue = {
  entries: WorkEntry[]
  /** Hosts whose entries are not current, by label. */
  behind: string[]
  /** Total shown; `partial` when any host is behind, so the count reads "N+". */
  count: number
  partial: boolean
  hosts: WorkHostStatus[]
}

const HOST_KEY = /^([a-z][a-z0-9-]{0,31})~(.+)$/s

/** The owning host (undefined for this host) and that host's own key of a Work entry key. */
export const parseWorkKey = (key: string) => {
  const match = HOST_KEY.exec(key)
  return match ? { host: match[1], key: match[2] } : { key }
}

const workHref = (key: string) => `/?item=${encodeURIComponent(key)}`

const hostStatus = (feed: HostFeed, behind: (feed: HostFeed) => boolean): WorkHostStatus => {
  const state = feed.state()
  return {
    id: feed.host.id,
    label: feed.host.label,
    status: state.status,
    ...(state.reason && state.status === "unavailable" ? { reason: state.reason } : {}),
    ...(state.since && state.status === "unavailable" ? { since: state.since } : {}),
    ...(state.checkedAt ? { checkedAt: state.checkedAt } : {}),
    partial: behind(feed),
  }
}

const remoteEntry = (feed: HostFeed, stale: boolean, key: string, entry: Omit<WorkEntry, "key" | "host" | "hostLabel" | "href" | "stale">): WorkEntry => {
  const state = feed.state()
  const qualified = `${feed.host.id}~${key}`
  return {
    key: qualified,
    host: feed.host.id,
    hostLabel: feed.host.label,
    href: workHref(qualified),
    stale,
    ...(state.status === "unavailable" ? { unavailableReason: state.reason ?? "network" } : {}),
    ...entry,
  }
}

const unavailable = (feed: HostFeed) => feed.state().status === "unavailable"
const decisionsBehind = (feed: HostFeed) => unavailable(feed) || feed.state().status === "loading" || !!feed.state().decisionsStale || !!feed.state().requestsStale

/** This host's items first (their existing order), then other Work hosts' open decisions (oldest first) and
 * pending requests. */
export const workQueue = (local: DeskItem[], feeds: HostFeed[]): WorkQueue => {
  const entries: WorkEntry[] = [
    ...local.map((item): WorkEntry => ({ key: item.key, kind: item.kind, title: item.series?.title ?? item.title, project: item.project, ...(item.record ? { created: item.record.created_at } : {}), href: workHref(item.key), stale: false, item })),
    ...feeds.flatMap((feed) => {
      const state = feed.state()
      return [
        ...[...state.decisions].sort((a, b) => a.created_at - b.created_at).map((record) =>
          remoteEntry(feed, unavailable(feed) || !!state.decisionsStale, `attention:${record.editspace}:${record.id}`, {
            kind: record.kind, title: record.title, project: record.editspace, created: record.created_at, remote: { kind: "attention", record },
          })),
        ...state.requests.map((request) =>
          remoteEntry(feed, unavailable(feed) || !!state.requestsStale, `${request.kind}:${request.directory}:${request.id}`, {
            kind: request.kind, title: request.title, ...(request.project ? { project: request.project } : {}), updated: request.checked, remote: { kind: "request", request },
          })),
      ]
    }),
  ]
  // A host not yet read is behind too: its entries are unknown, not zero.
  const behind = feeds.filter(decisionsBehind).map((feed) => feed.host.label)
  return { entries, behind, count: entries.length, partial: behind.length > 0, hosts: feeds.map((feed) => hostStatus(feed, decisionsBehind)) }
}

const surfacesBehind = (feed: HostFeed) => unavailable(feed) || feed.state().status === "loading" || !!feed.state().surfacesStale

/** This host's Surfaces first (their existing order), then other Work hosts' Surfaces, newest first. A host whose
 * dashboard serves no Surfaces lists none and is not behind. */
export const workSurfaces = (local: Surface[], feeds: HostFeed[]): WorkQueue => {
  const entries: WorkEntry[] = [
    ...local.map((surface): WorkEntry => ({ key: surfaceKey(surface.id), kind: "surface", title: surface.title, project: surface.editspace, updated: surface.updated_at, ...(surface.created_at ? { created: surface.created_at } : {}), href: workHref(surfaceKey(surface.id)), stale: false, surface })),
    ...feeds.flatMap((feed) => feed.state().surfaces.toSorted((a, b) => b.updated_at - a.updated_at).map((surface) =>
      remoteEntry(feed, surfacesBehind(feed), surfaceKey(surface.id), {
        kind: "surface", title: surface.title, project: surface.editspace, updated: surface.updated_at, ...(surface.created_at ? { created: surface.created_at } : {}),
        remote: { kind: "surface", surface, frame: surface.kind === "path" ? "host" : "own-host-only" },
      }))),
  ]
  const behind = feeds.filter(surfacesBehind).map((feed) => feed.host.label)
  return { entries, behind, count: entries.length, partial: behind.length > 0, hosts: feeds.map((feed) => hostStatus(feed, surfacesBehind)) }
}

/** "N" or "N+" for a count badge, with the hosts that make it partial named for its accessible label. */
export const workCountLabel = (queue: Pick<WorkQueue, "count" | "partial" | "behind">) => ({
  text: `${queue.count}${queue.partial ? "+" : ""}`,
  title: queue.partial ? `${queue.behind.join(", ")}: not current` : undefined,
})
