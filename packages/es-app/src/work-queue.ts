/* One Work queue for the unified navigation: this host's desk items (decisions, permissions, questions,
 * failures) and every other Work host's open decisions, each entry qualified by its host so equal record
 * IDs on two hosts stay two entries. Reuses existing reads only: the desk queue and the Work view host
 * feeds (their decision lists). Another host's entry opens on that host's own Front desk, where it is
 * answered with that host's operator session. A host whose list is not current makes the count partial
 * ("N+") and is named, never counted as zero. Personal hosts are not Work feeds and never appear. */
import type { DeskItem } from "./desk"
import type { AttentionRecord } from "./attention"
import type { HostFeed } from "./host-feed"
import { hostDecisionHref } from "./host-feed"

export type WorkEntry = {
  /** Unique across hosts: this host's desk key, or `<host>~attention:<es>:<id>` for another host. */
  key: string
  /** Undefined for this host. */
  host?: string
  hostLabel?: string
  kind: DeskItem["kind"]
  title: string
  project?: string
  /** Where opening it goes: this host's desk (`/?item=`) or that host's own Front desk. */
  href: string
  /** That host is unreachable or its list is not current: this is its last-known entry. */
  stale: boolean
  /** This host's desk item, when the entry is local (for rows that need the full item). */
  item?: DeskItem
}

export type WorkQueue = {
  entries: WorkEntry[]
  /** Hosts whose decisions are not current (unreachable or failed read), by label. */
  behind: string[]
  /** Total shown; `partial` when any host is behind, so the count reads "N+". */
  count: number
  partial: boolean
}

const hostEntry = (feed: HostFeed, record: AttentionRecord): WorkEntry => {
  const state = feed.state()
  return {
    key: `${feed.host.id}~attention:${record.editspace}:${record.id}`,
    host: feed.host.id,
    hostLabel: feed.host.label,
    kind: record.kind,
    title: record.title,
    project: record.editspace,
    href: hostDecisionHref(feed.host, record),
    stale: state.status === "unavailable" || !!state.decisionsStale,
  }
}

/** This host's items first (their existing order), then other Work hosts' open decisions, oldest first. */
export const workQueue = (local: DeskItem[], feeds: HostFeed[]): WorkQueue => {
  const entries: WorkEntry[] = [
    ...local.map((item): WorkEntry => ({ key: item.key, kind: item.kind, title: item.series?.title ?? item.title, project: item.project, href: `/?item=${encodeURIComponent(item.key)}`, stale: false, item })),
    ...feeds.flatMap((feed) => [...feed.state().decisions].sort((a, b) => a.created_at - b.created_at).map((record) => hostEntry(feed, record))),
  ]
  const behind = feeds.filter((feed) => feed.state().status === "unavailable" || feed.state().decisionsStale).map((feed) => feed.host.label)
  return { entries, behind, count: entries.length, partial: behind.length > 0 }
}

/** "N" or "N+" for a count badge, with the hosts that make it partial named for its accessible label. */
export const workCountLabel = (queue: WorkQueue) => ({
  text: `${queue.count}${queue.partial ? "+" : ""}`,
  title: queue.partial ? `${queue.behind.join(", ")}: not current` : undefined,
})
