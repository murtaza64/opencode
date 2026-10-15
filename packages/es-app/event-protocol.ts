export const eventProtocol = "opencode-events-v1"
export const eventPaths = ["/oc/global/event", "/oc/event", "/es/api/events", "/es/api/notification-events"]
export const eventMuxPaths = { opencode: "/oc/global/event", dashboard: "/es/api/notification-events" }

export type EventPacket =
  | { id: number; type: "open" }
  | { id: number; type: "message"; data: string; lastEventId: string }
  | { id: number; type: "error"; code?: number }

export const eventRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

// Optional subscribe filter: event type prefixes ("session.", "todo.updated").
// undefined = no filter; null = invalid request.
export const eventTypes = (value: unknown): string[] | undefined | null => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.length || value.length > 16) return null
  return value.every((item) => typeof item === "string" && /^[a-z0-9._-]{1,64}$/.test(item)) ? value : null
}
