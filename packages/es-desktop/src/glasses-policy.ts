// Permission and device-chooser policy for the Glasses page: only its own main frame may use the microphone or pick
// a Bluetooth device, so no other route or embedded frame gains either.

const GLASSES_PATH = "/glasses"
export const GLASSES_PICK_MS = 15_000

/** True when `url` is the Glasses page on this listener's origin. */
export function glassesPage(url: string | undefined, origin: string) {
  const parsed = URL.parse(url ?? "")
  return !!parsed && parsed.origin === origin && parsed.pathname === GLASSES_PATH
}

/** Media request policy: audio only, at least one media type, from the Glasses main frame. */
export function allowGlassesMedia(
  permission: string,
  details: { isMainFrame?: boolean; requestingUrl?: string; mediaTypes?: readonly string[] },
  origin: string,
) {
  if (permission !== "media" || details.isMainFrame !== true) return false
  const kinds = details.mediaTypes ?? []
  return kinds.length > 0 && kinds.every((kind) => kind === "audio") && glassesPage(details.requestingUrl, origin)
}

/** Media permission check policy (Chromium asks this before prompting): audio from the Glasses main frame. */
export function allowGlassesMediaCheck(
  permission: string,
  details: { isMainFrame?: boolean; requestingUrl?: string; mediaType?: string },
  origin: string,
) {
  return permission === "media" && details.isMainFrame === true && details.mediaType === "audio" && glassesPage(details.requestingUrl, origin)
}

/** Device id for the requested temple side ("R" or "L"), or undefined while none has been discovered. */
export function pickGlassesDevice(side: unknown, devices: readonly { deviceId: string; deviceName: string }[]) {
  if (side !== "R" && side !== "L") return undefined
  return devices.find((device) => new RegExp(`_${side}_`, "i").test(device.deviceName))?.deviceId
}
