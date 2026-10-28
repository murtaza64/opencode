/* Cloud agents (Wingman lanes this account already sees) as rows of the ordinary agent list, so the
 * list can show them beside sessions instead of in a separate drawer. Pure data: built from the existing
 * cloud-agents model (same lanes, account scope and pins); no new discovery, control or permission. Each
 * row carries its runtime ("cloud") and owner, so it never collides with a host session of the same name. */
import { cloudHref, cloudKey, type CloudPin } from "./cloud-agents"
import type { WingmanLane } from "./api"
import { wingmanActivityAt, wingmanStatus } from "./wingman"

export type CloudRow = {
  /** Stable across refreshes: the cloud pin key (editspace, lane, owner). */
  key: string
  runtime: "cloud"
  title: string
  project: string
  owner: string
  href: string
  /** The lane's real last activity (wingman-activity: the last change sync saw), or undefined when unknown.
   * Never the fetch time, so an old agent fetched just now never looks new. */
  updated?: number
  status: { label: string; chip: string }
  pinned: boolean
  /** The source for this project could not be read: the row is its last-known state. */
  stale: boolean
}

type Observed = { editspace: string; lane: string; owner: string; record: WingmanLane }
type Snapshot = { error?: string }

/** Rows for pinned cloud agents (always, last-known when stale) and the unpinned ones discovery shows. */
export const cloudRows = (input: {
  pins: CloudPin[]
  observed: Observed[]
  /** Unpinned agents the current view lists (the model's `other()`, finished ones included). */
  other: Observed[]
  snapshots: Record<string, Snapshot | undefined>
}): CloudRow[] => {
  const row = (pin: CloudPin, record: WingmanLane | undefined, pinned: boolean): CloudRow => ({
    key: cloudKey(pin),
    runtime: "cloud",
    title: pin.lane,
    project: pin.editspace,
    owner: pin.owner,
    href: cloudHref(pin),
    updated: record ? wingmanActivityAt(record) : undefined,
    // A pin whose owner the source no longer lists is shown as such, never as finished.
    status: record ? wingmanStatus(record["wingman-status"]) : { label: "owner not observed", chip: "plain" },
    pinned,
    stale: !!input.snapshots[pin.editspace]?.error,
  })
  const pinned = input.pins.map((pin) => row(pin, input.observed.find((item) => cloudKey(item) === cloudKey(pin))?.record, true))
  const keys = new Set(pinned.map((item) => item.key))
  const unpinned = input.other.filter((item) => !keys.has(cloudKey(item))).map((item) => row(item, item.record, false))
  return [...pinned, ...unpinned]
}

/** One list, newest first: session rows and cloud rows; rows without a time sort last, in their order. */
export const mergeAgentRows = <S extends { updated: number }>(sessions: S[], cloud: CloudRow[]) =>
  [...sessions.map((item) => ({ kind: "session" as const, updated: item.updated, item })), ...cloud.map((item) => ({ kind: "cloud" as const, updated: item.updated ?? -1, item }))]
    .sort((a, b) => b.updated - a.updated)
