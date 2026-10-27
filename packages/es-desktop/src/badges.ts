/* Decision counts for inactive host tabs, read from each host's own dashboard: open attention
 * records plus pending permission and question requests. Two small GETs per host per interval,
 * one in flight at a time, read-only (nothing is marked seen or answered). A host whose summary
 * cannot be read shows as unavailable, never as zero. */
import type { Badge } from "./tabs"

export type BadgeHost = { id: string; read: (path: string) => Promise<Response> }

const INTERVAL = 30_000

export const watchBadges = (hosts: BadgeHost[], set: (id: string, badge: Badge) => void, interval = INTERVAL) => {
  const running = new Set<string>()
  const check = (host: BadgeHost) => {
    if (running.has(host.id)) return
    running.add(host.id)
    void readBadge(host)
      .then((badge) => set(host.id, badge))
      .finally(() => running.delete(host.id))
  }
  const all = () => hosts.forEach(check)
  all()
  const timer = setInterval(all, interval)
  return () => clearInterval(timer)
}

export const readBadge = async (host: BadgeHost): Promise<Badge> => {
  const [attention, notifications] = await Promise.all([json(host, "/es/api/attention"), json(host, "/es/api/notifications")])
  if (!record(attention) || !Array.isArray(attention.records)) return "unavailable"
  const projects = Array.isArray(attention.projects) ? attention.projects.filter(record) : []
  // No project could be read: the count would be a guess.
  if (projects.length && projects.every((item) => item.available === false)) return "unavailable"
  const open = attention.records.filter((item) => record(item) && item.status === "open").length
  const requests = record(notifications) && Array.isArray(notifications.notifications)
    ? notifications.notifications.filter((item) => record(item) && (item.kind === "permission" || item.kind === "question")).length
    : undefined
  return { count: open + (requests ?? 0), partial: attention.partial === true || requests === undefined }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const json = (host: BadgeHost, path: string): Promise<unknown> =>
  host
    .read(path)
    .then(async (response) => {
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel()
        return undefined
      }
      return response.json()
    })
    .catch(() => undefined)
