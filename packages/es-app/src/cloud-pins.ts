import { createRoot, createSignal } from "solid-js"

// Cloud pins live apart from session pins: session pins are [directory, sessionID]
// tuples keyed to the local daemon, while a cloud lane outlives any one Wingman
// session (a respawn mints a new workflow id), so it is pinned by editspace + lane.
export const CLOUD_PIN_STORAGE_KEY = "es-app-cloud-pins"

export type CloudPin = { runtime: "wingman"; editspace: string; lane: string }

export const cloudPinKey = (pin: CloudPin) => JSON.stringify([pin.runtime, pin.editspace, pin.lane])

export const parseCloudPin = (key: string): CloudPin | undefined => {
  try {
    const value: unknown = JSON.parse(key)
    if (!Array.isArray(value) || value.length !== 3 || value[0] !== "wingman") return undefined
    if (typeof value[1] !== "string" || typeof value[2] !== "string" || !value[1] || !value[2]) return undefined
    return { runtime: "wingman", editspace: value[1], lane: value[2] }
  } catch {
    return undefined
  }
}

export const readCloudPins = (raw: string | null) => {
  try {
    const value: unknown = JSON.parse(raw ?? "[]")
    if (!Array.isArray(value)) return []
    return [...new Set(value.filter((key): key is string => typeof key === "string" && parseCloudPin(key) !== undefined))]
  } catch {
    return []
  }
}

export const toggledCloudPins = (keys: string[], pin: CloudPin) => {
  const key = cloudPinKey(pin)
  return keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key]
}

const store = createRoot(() => {
  const load = () => {
    try {
      return readCloudPins(localStorage.getItem(CLOUD_PIN_STORAGE_KEY))
    } catch {
      return []
    }
  }
  const [keys, setKeys] = createSignal<string[]>(load())
  const save = (next: string[]) => {
    setKeys(next)
    try {
      localStorage.setItem(CLOUD_PIN_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Keep the pin for this window when browser storage is unavailable.
    }
  }
  return { keys, save }
})

export const cloudPins = () => store.keys().flatMap((key) => parseCloudPin(key) ?? [])
export const isCloudPinned = (pin: CloudPin) => store.keys().includes(cloudPinKey(pin))
export const toggleCloudPin = (pin: CloudPin) => store.save(toggledCloudPins(store.keys(), pin))
