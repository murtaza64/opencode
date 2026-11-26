/* Decision counts for inactive host tabs, read from each host's own dashboard: open attention
 * records plus pending permission and question requests. Two small GETs per host per interval,
 * one in flight at a time, read-only (nothing is marked seen or answered). A host whose summary
 * cannot be read shows as unavailable, never as zero. */
import type { Badge } from "./tabs"

export type BadgeHost = { id: string; read: (path: string) => Promise<Response> }

const INTERVAL = 30_000

/** Why a host's count cannot be read: its sign-in lapsed (a refusal or a redirect to sign in), it does not answer, or
 * it answers something that is not its count. */
export type Unavailable = "signed-out" | "unreachable" | "error"

export const watchBadges = (
  hosts: BadgeHost[],
  set: (id: string, badge: Badge, reason?: Unavailable) => void,
  interval = INTERVAL,
  // Reads pause while this is false (window hidden or minimized) and resume with one read.
  visible: () => boolean = () => true,
) => {
  const running = new Set<string>()
  const check = (host: BadgeHost) => {
    if (running.has(host.id)) return
    running.add(host.id)
    void readBadgeReason(host)
      .then((result) => set(host.id, result.badge, result.reason))
      .finally(() => running.delete(host.id))
  }
  const all = () => {
    if (visible()) hosts.forEach(check)
  }
  all()
  const timer = setInterval(all, interval)
  return { stop: () => clearInterval(timer), refresh: all }
}

export const readBadge = async (host: BadgeHost): Promise<Badge> => (await readBadgeReason(host)).badge

/** A host's count, and when it cannot be read, why (`reason`). */
export const readBadgeReason = async (host: BadgeHost): Promise<{ badge: Badge; reason?: Unavailable }> => {
  const [read, notifications] = await Promise.all([json(host, "/es/api/attention"), json(host, "/es/api/notifications").then((item) => item.value)])
  const attention = read.value
  if (!record(attention) || !Array.isArray(attention.records)) return { badge: "unavailable", reason: read.failure ?? "error" }
  const projects = Array.isArray(attention.projects) ? attention.projects.filter(record) : []
  // No project could be read: the count would be a guess.
  if (projects.length && projects.every((item) => item.available === false)) return { badge: "unavailable", reason: "error" }
  const open = attention.records.filter((item) => record(item) && item.status === "open").length
  const requests = record(notifications) && Array.isArray(notifications.notifications)
    ? notifications.notifications.filter((item) => record(item) && (item.kind === "permission" || item.kind === "question")).length
    : undefined
  return { badge: { count: open + (requests ?? 0), partial: attention.partial === true || requests === undefined } }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const json = (host: BadgeHost, path: string): Promise<{ value?: unknown; failure?: Unavailable }> =>
  host
    .read(path)
    .then(async (response) => {
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel()
        return { failure: response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400) ? "signed-out" as const : "error" as const }
      }
      return { value: await response.json().catch(() => undefined), failure: "error" as const }
    })
    // Reads refuse redirects: a redirect is a sign-in step; anything else thrown is no answer.
    .catch((error: unknown) => ({ failure: /redirect/i.test(String((error as { message?: unknown })?.message ?? error)) ? "signed-out" as const : "unreachable" as const }))
