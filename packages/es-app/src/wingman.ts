import type { WingmanLane } from "./api"

export const wingmanStatus = (status?: string) => {
  switch (status) {
    case "processing": return { label: "working", chip: "busy" }
    case "waiting": return { label: "waiting", chip: "parked" }
    case "ended": return { label: "ended", chip: "plain" }
    case "failed": return { label: "failed", chip: "failing" }
    case "timed_out": return { label: "timed out", chip: "failing" }
    default: return { label: status || "starting", chip: "plain" }
  }
}

export const wingmanPrs = (value?: string) =>
  (value ?? "").split(/\s+/).filter((url) => URL.parse(url)?.protocol === "https:")

/** Epoch ms of the lane's last activity (the last change sync saw), or undefined when unknown. */
export const wingmanActivityAt = (lane: WingmanLane) => {
  const value = Date.parse(lane["wingman-activity"] ?? "")
  return Number.isNaN(value) ? undefined : value
}

/** Epoch ms of the lane's last successful sync, if the dashboard recorded one (freshness, not activity). */
export const wingmanSyncedAt = (lane: WingmanLane) => {
  const value = Date.parse(lane["wingman-synced"] ?? "")
  return Number.isNaN(value) ? undefined : value
}

/** The Temporal run link, only when it points where Wingman runs live. */
export const wingmanRunUrl = (lane: WingmanLane) =>
  lane["wingman-url"]?.startsWith("https://cloud.temporal.io/") ? lane["wingman-url"] : undefined
