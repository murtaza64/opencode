import { lanePinRef, moveRank, orderedPins, pinUnionKey, sessionPinRef, unionPins, validPinRef, type Pin, type PinsClient } from "./pins-sync"
import { pinSessionID } from "./session-pins"

export type PinRow = { id: string; directory: string }
export type PinOwner = { editspace: string; lane: string; owner: string }
export type PinGroup<T extends PinRow> = { host: string; rows: T[]; owners: PinOwner[]; client?: PinsClient }

export const orderingPinsClient = (client: PinsClient | undefined, migrated: boolean) => {
  if (!client || !migrated) return
  const state = client.state()
  if (state.reason === "profile") return
  return state.status === "ready" || (state.status === "unavailable" && state.pins.length > 0) ? client : undefined
}

type MigrationSource =
  | { kind: "local"; dashboard: boolean; handoffs: boolean; sessions: boolean; otherLineages: boolean }
  | { kind: "work"; feed: boolean; lineage: boolean; legacyPins: boolean }

export const pinMigrationReady = (source: MigrationSource) =>
  source.kind === "local" ? source.dashboard && source.handoffs && source.sessions && source.otherLineages
    : source.feed && (source.lineage || !source.legacyPins)

export const migrateReadyPins = (client: PinsClient, source: MigrationSource, keys: string[], rows: PinRow[], owners: PinOwner[]) => {
  if (client.state().status !== "ready" || !pinMigrationReady(source)) return
  return client.migrate(migrationRefs(keys, rows, owners))
}

export const legacyPinsCovered = (keys: string[], rows: PinRow[]) => keys.every((key) => {
  const id = pinSessionID(key)
  if (!id) return true
  try {
    const value: unknown = JSON.parse(key)
    return Array.isArray(value) && rows.some((row) => row.id === id && row.directory === value[0])
  } catch { return false }
})

// Rows do not carry lane identity. Only a confirmed current owner can be assigned a lane ref.
export const rowPinRef = (row: PinRow, owners: PinOwner[]) => {
  const matches = owners.filter((item) => item.owner === row.id)
  const lane = matches.length === 1 ? lanePinRef(matches[0]!.editspace, matches[0]!.lane) : undefined
  return lane && validPinRef(lane) ? lane : sessionPinRef(row.id)
}

export const rowPin = (row: PinRow, owners: PinOwner[], pins: Pin[]) => {
  const refs = [rowPinRef(row, owners), sessionPinRef(row.id)]
  return orderedPins(pins).find((pin) => refs.includes(pin.ref))
}

export const isRowPinned = (row: PinRow, keys: string[], owners: PinOwner[], client?: PinsClient) =>
  client ? !!rowPin(row, owners, client.state().pins) : keys.some((key) => pinSessionID(key) === row.id)

export const pinnedRows = <T extends PinRow>(rows: T[], owners: PinOwner[], client: PinsClient) => {
  const pins = orderedPins(client.state().pins)
  return pins.flatMap((pin) => rows.flatMap((row) => rowPin(row, owners, pins)?.ref === pin.ref ? [{ ...row, pinnedAt: pin.pinnedAt }] : []))
    .filter((row, index, all) => all.findIndex((item) => item.id === row.id) === index)
}

export const pinnedUnionRows = <T extends PinRow>(groups: PinGroup<T>[]) => {
  const visible = new Map(groups.flatMap((group) => {
    const client = group.client
    if (!client) return []
    return group.rows.flatMap((row) => {
      const pin = rowPin(row, group.owners, client.state().pins)
      return pin ? [[pinUnionKey(group.host, pin.ref), row] as const] : []
    })
  }))
  // Fallback hosts follow the synced union, Local first then Work registry order, retaining each host's local pin order.
  return [
    ...unionPins(groups.flatMap((group) => group.client ? [{ host: group.host, pins: group.client.state().pins }] : []))
      .flatMap((pin) => visible.get(pinUnionKey(pin.host, pin.ref)) ?? []),
    ...groups.flatMap((group) => group.client ? [] : group.rows),
  ]
}

export const movePinnedRow = (
  ownHost: string, groups: PinGroup<PinRow & { host?: string }>[], row: PinRow & { host?: string },
  before?: PinRow & { host?: string }, after?: PinRow & { host?: string },
) => {
  const host = row.host ?? ownHost
  const group = groups.find((item) => item.host === host)
  if (!group?.client || group.client.state().status !== "ready" || !group.rows.some((item) => item.id === row.id)) return false
  const ref = rowPin(row, group.owners, group.client.state().pins)?.ref
  if (!ref) return false
  const visible = unionPins(groups.flatMap((item) => item.client?.state().status === "ready" ? [{ host: item.host, pins: item.client.state().pins }] : []))
    .filter((pin) => groups.some((item) => {
      const client = item.client
      return item.host === pin.host && client?.state().status === "ready" &&
        item.rows.some((entry) => rowPin(entry, item.owners, client.state().pins)?.ref === pin.ref)
    }))
  const key = pinUnionKey(host, ref)
  if (!visible.some((pin) => pinUnionKey(pin.host, pin.ref) === key)) return false
  const remaining = visible.filter((pin) => pinUnionKey(pin.host, pin.ref) !== key)
  const indexOf = (anchor: (PinRow & { host?: string }) | undefined) => {
    if (!anchor) return undefined
    const source = groups.find((item) => item.host === (anchor.host ?? ownHost))
    if (!source?.client || source.client.state().status !== "ready" || !source.rows.some((item) => item.id === anchor.id)) return -1
    const pin = rowPin(anchor, source.owners, source.client.state().pins)
    return remaining.findIndex((item) => pinUnionKey(item.host, item.ref) === pinUnionKey(source.host, pin?.ref ?? ""))
  }
  const above = indexOf(before)
  const below = indexOf(after)
  if ((above !== undefined && above < 0) || (below !== undefined && below < 0)) return false
  if (above !== undefined && below !== undefined && below !== above + 1) return false
  if (above === undefined && below !== undefined && below !== 0) return false
  if (below === undefined && above !== undefined && above !== remaining.length - 1) return false
  if (above === undefined && below === undefined && remaining.length) return false
  void group.client.reorder(ref, moveRank(above === undefined ? undefined : remaining[above], below === undefined ? undefined : remaining[below]))
  return true
}

export const migrationRefs = (keys: string[], rows: PinRow[], owners: PinOwner[]) =>
  [...new Set(keys.flatMap((key) => {
    const id = pinSessionID(key)
    if (!id) return []
    const row = rows.find((item) => item.id === id)
    return [row ? rowPinRef(row, owners) : sessionPinRef(id)]
  }))].filter(validPinRef).map((ref) => ({ ref }))
