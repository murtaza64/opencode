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
import { deliverables, surfaceKey, type Surface } from "./surfaces"
import { workCountLabel, workQueue, workTries, type WorkEntry } from "./work-queue"

// An update its author marked FYI asks nothing: it stays in the Surfaces list (unseen, with its line) and never enters
// Needs you (Murtaza 2026-11-04, "it shows up in my needs. But I don't know exactly what it is for").
export const asksSomething = (surface: Pick<Surface, "change">) => surface.change?.intent !== "fyi"

export const needsYou = (input: { items: DeskItem[]; feeds: HostFeed[]; fresh: Surface[]; local?: Surface[]; closed?: AttentionRecord[] }) => {
  const queue = workQueue(input.items, input.feeds)
  const all = workTries(input.feeds)
  const tries = { ...all, entries: all.entries.filter((entry) => entry.remote?.kind !== "surface" || asksSomething(entry.remote.surface)) }
  const fresh = input.fresh.filter(asksSomething)
  const linked = linkArtifacts({ entries: queue.entries, fresh, tries: tries.entries, local: input.local ?? fresh, feeds: input.feeds, closed: input.closed ?? [] })
  const count = linked.entries.length + linked.fresh.length + linked.tries.length + linked.items.length
  const behind = [...new Set([...queue.behind, ...tries.behind])]
  return {
    entries: linked.entries,
    fresh: linked.fresh,
    /** Other Work hosts' fresh deliverables (host-qualified Try rows). */
    tries: linked.tries,
    /** A Surface and the open decisions that point at it, as one item (opens the Surface reader). */
    linked: linked.items,
    /** The outcome of a closed decision about a still-fresh Try, by the Try's key. */
    outcomes: linked.outcomes,
    count,
    partial: behind.length > 0,
    behind,
    /** The Needs you heading: decisions, requests, failures and fresh deliverables of every Work host. */
    label: workCountLabel({ ...queue, count, behind, partial: behind.length > 0 }),
    /** The Decisions tab: the same entries without deliverables; a linked item counts once. */
    decisions: workCountLabel({ ...queue, count: linked.entries.length + linked.items.length }),
  }
}

/** One item per artifact: a Surface plus the open decisions whose `artifact.surface` names it on the same host. */
export type LinkedItem = {
  /** The Surface's work key (`surface:<id>`, or `<host>~surface:<id>`): opening it opens the Surface reader. */
  key: string
  host?: string
  hostLabel?: string
  href: string
  stale: boolean
  surface: Surface
  decisions: AttentionRecord[]
  /** The Surface's current revision is not yet seen. */
  fresh: boolean
}

/** The Surface id a record explicitly points at, if any. Titles are never matched. */
export const artifactSurface = (record: AttentionRecord | undefined) =>
  typeof record?.artifact?.surface === "string" ? record.artifact.surface : undefined

/** "decision is about rev N" when a decision names an older revision than the Surface now has. */
export const staleArtifact = (record: AttentionRecord, surface: Surface) => {
  const revision = Number(record.artifact?.revision)
  return Number.isFinite(revision) && revision !== surface.revision ? `decision is about rev ${record.artifact?.revision}` : undefined
}

// Presentation only: records and Surfaces are not changed; a decision whose Surface is not listed stays its own row.
const linkArtifacts = (input: { entries: WorkEntry[]; fresh: Surface[]; tries: WorkEntry[]; local: Surface[]; feeds: HostFeed[]; closed: AttentionRecord[] }) => {
  const items = new Map<string, LinkedItem>()
  const entries = input.entries.filter((entry) => {
    const record = entry.item?.series ? undefined : entry.item?.record ?? (entry.remote?.kind === "attention" ? entry.remote.record : undefined)
    const id = artifactSurface(record)
    const surface = id === undefined ? undefined : entry.host
      ? input.feeds.find((feed) => feed.host.id === entry.host)?.state().surfaces.find((item) => item.id === id)
      : input.local.find((item) => item.id === id)
    if (!record || !surface) return true
    const key = entry.host ? `${entry.host}~${surfaceKey(surface.id)}` : surfaceKey(surface.id)
    const item = items.get(key) ?? { key, ...(entry.host ? { host: entry.host, hostLabel: entry.hostLabel } : {}), href: `/?item=${encodeURIComponent(key)}`, stale: entry.stale, surface, decisions: [], fresh: false }
    items.set(key, { ...item, stale: item.stale || entry.stale, decisions: [...item.decisions, record] })
    return false
  })
  const fresh = input.fresh.filter((surface) => {
    const item = items.get(surfaceKey(surface.id))
    if (item) item.fresh = true
    return !item
  })
  const tries = input.tries.filter((entry) => {
    const item = items.get(entry.key)
    if (item) item.fresh = true
    return !item
  })
  // A closed local decision about a fresh Try: the Try row shows how it ended until the Surface is viewed.
  const outcomes = new Map<string, AttentionRecord>()
  for (const record of input.closed.toSorted((a, b) => a.updated_at - b.updated_at)) {
    const id = artifactSurface(record)
    if (id !== undefined && record.status !== "open" && fresh.some((surface) => surface.id === id)) outcomes.set(surfaceKey(id), record)
  }
  return { entries, fresh, tries, items: [...items.values()], outcomes }
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
  const result = needsYou({ items, feeds, fresh: deliverables(body.inputs.deliverables, new Map()).fresh })
  const perEditspace = body.records.reduce((counts, record) => counts.set(record.editspace, (counts.get(record.editspace) ?? 0) + 1), new Map<string, number>())
  const truncated = [...perEditspace.values()].some((count) => count >= body.limit)
  const behind = body.partial || truncated || sources.some((source) => !source.ok)
  if (!behind) return result
  return { ...result, partial: true, label: { text: `${result.count}+`, title: result.label.title ?? "Some Needs you sources are not current" } }
}
