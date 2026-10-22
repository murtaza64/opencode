type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export const composerStorage = (userAgent: string, tab: DraftStorage, persistent: () => DraftStorage) => {
  // Native shells (Electron, the Android WebView shell) have one window and a stable,
  // profile-owned origin; Android may also recreate the page after process death.
  // Browser tabs stay independent.
  if (!/\b(Electron|EditspaceAndroid)\/\d/.test(userAgent)) return tab
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
