import { createSignal } from "solid-js"
import { ApiStatusError, es, type CurrentWork } from "./api"

export type CurrentWorkSnapshot = { value: CurrentWork | null; checked: number; error: boolean }
type Entry = {
  state: () => CurrentWorkSnapshot
  set: (value: CurrentWorkSnapshot) => void
  attempted: number
  pending?: Promise<void>
}
const entries = new Map<string, Entry>()
let missingUntil = 0

const keyFor = (id: string, directory: string) => `${directory}\u0000${id}`
const entryFor = (id: string, directory: string) => {
  const key = keyFor(id, directory)
  const cached = entries.get(key)
  if (cached) return cached
  const [state, set] = createSignal<CurrentWorkSnapshot>({ value: null, checked: 0, error: false })
  const entry: Entry = { state, set, attempted: 0 }
  entries.set(key, entry)
  // Bound cache size, while preserving the selected session on subsequent reads.
  if (entries.size > 100) entries.delete(entries.keys().next().value!)
  return entry
}

export const currentWork = (id: string, directory: string) => {
  const entry = entryFor(id, directory)
  const previous = entry.state()
  const interval = previous.error ? 30_000 : previous.value?.turn.status === "busy" ? 5_000 : 30_000
  if (entry.pending || Date.now() < missingUntil || Date.now() - entry.attempted < interval) return entry.state
  entry.attempted = Date.now()
  entry.pending = es.currentWork(id, directory)
    .then((value) => {
      entry.set({ value, checked: Date.now(), error: false })
    })
    .catch((error) => {
      if (error instanceof ApiStatusError && error.routeMissing) missingUntil = Date.now() + 10 * 60_000
      entry.set({ ...entry.state(), error: true })
    })
    .finally(() => {
      entry.pending = undefined
    })
  return entry.state
}
