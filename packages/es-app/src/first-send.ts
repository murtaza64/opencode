// One-shot hand-off from the draft New session page to the created session's composer.
export const firstSendKey = "es-app:first-send:1"

// Returns the text once, for this exact session, and forgets it so a reload never resends.
export const takeFirstSend = (sessionID: string, storage: Pick<Storage, "getItem" | "removeItem"> = sessionStorage) => {
  try {
    const value = JSON.parse(storage.getItem(firstSendKey) ?? "null")
    if (!value || value.sessionID !== sessionID || typeof value.text !== "string") return undefined
    storage.removeItem(firstSendKey)
    return value.text as string
  } catch {
    return undefined
  }
}
