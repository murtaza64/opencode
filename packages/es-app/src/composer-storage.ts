type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export const composerStorage = (userAgent: string, tab: DraftStorage, persistent: () => DraftStorage) => {
  // The native shell has one window and a stable, profile-owned origin. Browser tabs stay independent.
  if (!/\bElectron\/\d/.test(userAgent)) return tab
  const durable = persistent()
  return {
    getItem: (key: string) => durable.getItem(key) ?? tab.getItem(key),
    setItem: (key: string, value: string) => {
      durable.setItem(key, value)
      // Retire legacy tab data only after the durable write succeeds.
      try {
        tab.removeItem(key)
      } catch {
        /* A stale tab copy cannot override durable data. */
      }
    },
  }
}
