// This shell uses one daemon, whose Session IDs are global. Directory spellings
// are routing metadata; retain the tuple format for existing persisted pins.
export const pinSessionID = (key: string) => {
  try {
    const value: unknown = JSON.parse(key)
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" &&
      typeof value[1] === "string" && value[1] ? value[1] : undefined
  } catch {
    return undefined
  }
}
