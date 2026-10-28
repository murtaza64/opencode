import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { es, type WingmanLane } from "./api"
import { CLOUD_PIN_STORAGE_KEY, parseCloudPin } from "./cloud-pins"

export type CloudPin = { editspace: string; lane: string; owner: string }
type Snapshot = { lanes: WingmanLane[]; checked: number; error: string }

export const cloudKey = (pin: CloudPin) => JSON.stringify([pin.editspace, pin.lane, pin.owner])
export const cloudHref = (pin: CloudPin) => `/cloud?es=${encodeURIComponent(pin.editspace)}&lane=${encodeURIComponent(pin.lane)}&owner=${encodeURIComponent(pin.owner)}`
export const cloudOwnerKnown = (owner: string) => owner.startsWith("wingman:") && owner.length > 8 && owner !== "wingman:pending"

const maxScopes = 5

export const decodeCloudPins = (raw: string | null): CloudPin[] => {
  try {
    const value: unknown = JSON.parse(raw ?? "[]")
    if (!Array.isArray(value)) return []
    return [...new Map(value.flatMap(item => {
      if (typeof item === "string") {
        const legacy = parseCloudPin(item)
        return legacy ? [{ editspace: legacy.editspace, lane: legacy.lane, owner: "" }] : []
      }
      return (
      item !== null && typeof item === "object" &&
      typeof item.editspace === "string" && !!item.editspace &&
      typeof item.lane === "string" && !!item.lane &&
      typeof item.owner === "string") ? [{ editspace: item.editspace, lane: item.lane, owner: item.owner }] : []
    }).map(item => [cloudKey(item), item])).values()]
  } catch { return [] }
}

export const createCloudAgents = (options: {
  project: () => string | undefined
  defaultProject: () => string | undefined
  targetProject?: () => string | undefined
}) => {
  const [pins, setPins] = createSignal<CloudPin[]>((() => { try { return decodeCloudPins(localStorage.getItem(CLOUD_PIN_STORAGE_KEY)) } catch { return [] } })())
  const [snapshots, setSnapshots] = createSignal<Record<string, Snapshot>>({})
  const [now, setNow] = createSignal(Date.now())
  const [inflight, setInflight] = createSignal<Record<string, number>>({})
  const [pinError, setPinError] = createSignal("")
  const [includeFinished, setIncludeFinished] = createSignal(false)
  const discovery = createMemo(() => [...new Set([options.targetProject?.(), options.project() ?? options.defaultProject()].filter((name): name is string => !!name))])
  // Discovery gets priority; remaining slots are reserved for explicitly pinned projects.
  const scopes = createMemo(() => [...new Set([...discovery(), ...pins().map(pin => pin.editspace)])].slice(0, maxScopes))
  const observed = createMemo(() => scopes().flatMap(editspace => (snapshots()[editspace]?.lanes ?? [])
    .filter((lane): lane is WingmanLane & { lane: string; owner: string } => !!lane.lane && !!lane.owner)
    .map(record => ({ editspace, lane: record.lane, owner: record.owner, record }))))
  const allPinned = createMemo(() => pins().map(pin => ({ pin,
    record: observed().find(item => cloudKey(item) === cloudKey(pin))?.record,
    snapshot: snapshots()[pin.editspace], inScope: scopes().includes(pin.editspace),
  })))
  // Every agent the view's projects list, finished ones included: finished agents sort by their real last
  // activity like any other row instead of being hidden. `includeFinished` no longer filters (kept for
  // callers until the drawer is removed).
  const other = createMemo(() => observed().filter(item => discovery().includes(item.editspace) &&
    !pins().some(pin => cloudKey(pin) === cloudKey(item))))

  const togglePin = (pin: CloudPin) => {
    if (!pins().some(item => cloudKey(item) === cloudKey(pin)) && !cloudOwnerKnown(pin.owner)) {
      setPinError("Cloud task owner is not known yet. Wait for the lane source before pinning.")
      return
    }
    const next = pins().some(item => cloudKey(item) === cloudKey(pin))
      ? pins().filter(item => cloudKey(item) !== cloudKey(pin))
      : [...pins(), { editspace: pin.editspace, lane: pin.lane, owner: pin.owner }]
    try { localStorage.setItem(CLOUD_PIN_STORAGE_KEY, JSON.stringify(next)); setPins(next); setPinError("") }
    catch { setPinError("Cloud pin could not be saved. Existing pins were kept.") }
  }

  const versions = new Map<string, number>()
  let disposed = false
  const refresh = async (names?: string[]) => {
    const selected = [...new Set((names ?? scopes()).filter(name => scopes().includes(name)))].slice(0, maxScopes)
    if (!selected.length) return
    await Promise.all(selected.map(async name => {
      const current = (versions.get(name) ?? 0) + 1
      versions.set(name, current)
      setInflight(previous => ({ ...previous, [name]: current }))
      const result = await (async () => {
      try {
        const value = await es.wingman(name)
        if (!Array.isArray(value.lanes)) throw new Error("Invalid lane snapshot")
        return { name, snapshot: { lanes: value.lanes, checked: Date.now(), error: value.error || "" } }
      } catch { return { name, snapshot: { error: "Cloud lane source unavailable; last-known snapshot retained." } } }
      })()
      if (disposed || versions.get(name) !== current) return
      setSnapshots(previous => ({ ...previous, [name]: {
        lanes: result.snapshot.lanes ?? previous[name]?.lanes ?? [],
        checked: result.snapshot.checked ?? previous[name]?.checked ?? 0,
        error: result.snapshot.error,
      } }))
      setInflight(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== name)))
    }))
    if (disposed) return
    const migrated = [...new Map(pins().map(pin => {
      if (pin.owner) return pin
      const candidates = observed().filter(item => item.editspace === pin.editspace && item.lane === pin.lane)
      return candidates.length === 1 && cloudOwnerKnown(candidates[0]!.owner) && !snapshots()[pin.editspace]?.error ? { ...pin, owner: candidates[0]!.owner } : pin
    }).map(pin => [cloudKey(pin), pin])).values()]
    if (migrated.length !== pins().length || migrated.some((pin, index) => pin.owner !== pins()[index]?.owner)) {
      try { localStorage.setItem(CLOUD_PIN_STORAGE_KEY, JSON.stringify(migrated)); setPins(migrated) }
      catch { setPinError("Legacy cloud pin could not be bound to its observed owner. Existing pin was kept.") }
    }
  }
  createEffect(() => { const names = scopes(); if (names.length) void refresh(names) })
  const interval = setInterval(() => { setNow(Date.now()); void refresh() }, 60_000)
  onCleanup(() => { clearInterval(interval); disposed = true })

  return { pins, snapshots, now, loading: () => Object.keys(inflight()).length > 0, pinError, includeFinished, setIncludeFinished, scopes, observed, allPinned, other, togglePin, refresh }
}
