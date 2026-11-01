/* Subscription quota rows for the Usage page (COST-02 Q1). Each provider shows its state honestly: a window
 * the snapshot lacks is absent, and an unknown value is a label, never 0. Numbers come only from the host's
 * quota snapshots, never from docs. Kept apart from API spend and token activity. */
import type { QuotaProvider, QuotaView } from "./api"

export type QuotaBar = { id: string; label: string; percent: number; reset: string | undefined }
export type QuotaRow = { provider: string; label: string; status: string | undefined; experimental: boolean; bars: QuotaBar[] }

const PROVIDER: Record<string, string> = { claude: "Claude", codex: "Codex" }
const WINDOW: Record<string, string> = { five_hour: "5-hour", seven_day: "7-day" }

export const quotaRows = (view: QuotaView, now: number): QuotaRow[] => view.providers.map((item) => ({
  provider: item.provider,
  label: PROVIDER[item.provider] ?? item.provider,
  status: status(item),
  experimental: item.pinned === false,
  // Not configured or unavailable: no bars at all, so nothing reads as 0% used.
  bars: item.state === "ok" || item.state === "stale" ? item.windows.map((window) => ({
    id: window.id,
    label: WINDOW[window.id] ?? windowLabel(window.id, window.windowDurationMins),
    percent: Math.round(window.usedPercent),
    reset: item.state === "ok" ? countdown(window.resetsAt, now) : undefined,
  })) : [],
}))

const status = (item: QuotaProvider) => {
  if (item.state === "not-configured") return "Not configured"
  if (item.state === "unavailable") return item.reason ? `Unavailable (${item.reason})` : "Unavailable"
  if (item.state === "stale") return `Stale since ${clock(item.staleSince)}`
  return undefined
}

export const countdown = (resetsAt: string | undefined, now: number) => {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (!Number.isFinite(at)) return undefined
  const minutes = Math.max(1, Math.ceil((at - now) / 60_000))
  if (minutes < 60) return `resets in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `resets in ${hours}h ${minutes % 60}m`
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`
}

const windowLabel = (id: string, minutes?: number) => {
  const name = id.split("/").at(-1) ?? id
  if (!minutes) return name
  return `${name} (${minutes % 1440 === 0 ? `${minutes / 1440}-day` : minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`})`
}

const clock = (iso: string | undefined) => {
  const at = iso ? Date.parse(iso) : NaN
  return Number.isFinite(at) ? new Date(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "an unknown time"
}
