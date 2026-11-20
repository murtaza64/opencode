// Device-chooser policy for the glasses: only the app's own page may pick a temple.

const GLASSES_PATH = "/glasses"
export const GLASSES_PICK_MS = 15_000

/** True when `url` is the Glasses page on this listener's origin. */
export function glassesPage(url: string | undefined, origin: string) {
  const parsed = URL.parse(url ?? "")
  return !!parsed && parsed.origin === origin && parsed.pathname === GLASSES_PATH
}

/** Device id for the requested temple side ("R" or "L"), or undefined while none has been discovered. */
export function pickGlassesDevice(side: unknown, devices: readonly { deviceId: string; deviceName: string }[]) {
  if (side !== "R" && side !== "L") return undefined
  return devices.find((device) => new RegExp(`_${side}_`, "i").test(device.deviceName))?.deviceId
}

/** One temple-chooser round: refuse off the Glasses page, pick the requested side, or keep waiting for it. */
export function pickDecision(input: {
  contentsURL: string
  pageHref: unknown
  side: unknown
  devices: readonly { deviceId: string; deviceName: string }[]
  origin: string
}) {
  const sameOrigin = URL.parse(input.contentsURL)?.origin === input.origin
  if (!sameOrigin || typeof input.pageHref !== "string" || !glassesPage(input.pageHref, input.origin)) return { kind: "refuse" as const }
  const deviceId = pickGlassesDevice(input.side, input.devices)
  return deviceId ? { kind: "pick" as const, deviceId } : { kind: "wait" as const }
}
