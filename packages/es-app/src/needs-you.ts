/* The Needs you collection and its count, as one pure selector for every surface that shows it (the
 * sidebar band, the Decisions tab and, later, the Dock badge). It composes the existing reads only:
 * this host's desk items, other Work hosts' open decisions and requested deliverables not yet seen.
 * Idle or finished sessions are never part of it. A host whose decisions are not current makes the
 * count partial ("N+"), never zero. */
import type { SessionFailure } from "@opencode-ai/sdk/v2"
import type { AttentionRecord } from "./attention"
import { deskItems, type DeskItem } from "./desk"
import type { HomeRequestRow } from "./home-requests"
import type { HostFeed } from "./host-feed"
import { deliverables, type Surface } from "./surfaces"
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

/** `GET /es/api/attention?include=needs-you-inputs` (dashboard schema needs-you-inputs/1): the open
 * attention records plus every other source's raw rows. Policy stays here, not in the dashboard. */
export type NeedsYouInputs = {
  records: AttentionRecord[]
  projects: { editspace: string; available: boolean }[]
  partial: boolean
  limit: number
  inputs: {
    schema: "needs-you-inputs/1"
    boot: string
    rev: number
    requests: HomeRequestRow[]
    failures: SessionFailure[]
    ignores: { sessionID: string; messageID: string }[]
    deliverables: Surface[]
    sources: Record<"requests" | "failures" | "ignores" | "deliverables", { checked_at: number | null; ok: boolean }>
  }
}

// The Front desk's own brief passes run in sessions with this ID class; their failures are not work
// waiting on the human. Desk task children use ses_fdtask_ and do count.
const BRIEF_JOB = /^ses_fdjob_[0-9a-f]{24}$/

/** The Needs you count for a client that reads the dashboard instead of running the app's own reads
 * (the desktop Dock badge), over all projects. Undefined until every source has been read once; a
 * source that failed since, or an editspace at the page limit, makes the count partial ("N+"). */
export const needsYouFromInputs = (body: NeedsYouInputs, feeds: HostFeed[]) => {
  const sources = Object.values(body.inputs.sources)
  if (sources.some((source) => source.checked_at === null)) return undefined
  const ignored = new Set(body.inputs.ignores.map((item) => `${item.sessionID}\n${item.messageID}`))
  const items = deskItems({
    records: body.records,
    attentionChecked: 0,
    requests: body.inputs.requests,
    failures: body.inputs.failures.filter((failure) => !BRIEF_JOB.test(failure.sessionID) && !ignored.has(`${failure.sessionID}\n${failure.messageID}`)),
    failuresChecked: 0,
    title: () => undefined,
    project: () => undefined,
  })
  const result = needsYou({ items, feeds, fresh: deliverables(body.inputs.deliverables, new Set()).fresh })
  const perEditspace = body.records.reduce((counts, record) => counts.set(record.editspace, (counts.get(record.editspace) ?? 0) + 1), new Map<string, number>())
  const truncated = [...perEditspace.values()].some((count) => count >= body.limit)
  const behind = body.partial || truncated || sources.some((source) => !source.ok)
  if (!behind) return result
  return { ...result, partial: true, label: { text: `${result.count}+`, title: result.label.title ?? "Some Needs you sources are not current" } }
}
