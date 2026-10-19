// Legacy lane-only pin keys. cloud-agents owns the single live store and binds
// these keys to an observed owner before persisting the canonical pin schema.
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
