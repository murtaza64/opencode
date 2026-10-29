/* The Needs you collection and its count, as one pure selector for every surface that shows it (the
 * sidebar band, the Decisions tab and, later, the Dock badge). It composes the existing reads only:
 * this host's desk items, other Work hosts' open decisions and requested deliverables not yet seen.
 * Idle or finished sessions are never part of it. A host whose decisions are not current makes the
 * count partial ("N+"), never zero. */
import type { DeskItem } from "./desk"
import type { HostFeed } from "./host-feed"
import type { Surface } from "./surfaces"
import { workCountLabel, workQueue } from "./work-queue"

export const needsYou = (input: { items: DeskItem[]; feeds: HostFeed[]; fresh: Surface[] }) => {
  const queue = workQueue(input.items, input.feeds)
  const count = queue.count + input.fresh.length
  return {
    entries: queue.entries,
    fresh: input.fresh,
    count,
    partial: queue.partial,
    behind: queue.behind,
    /** The Needs you heading: decisions, requests, failures and fresh deliverables. */
    label: workCountLabel({ ...queue, count }),
    /** The Decisions tab: the same entries without deliverables. */
    decisions: workCountLabel(queue),
  }
}
