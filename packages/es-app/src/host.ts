/* The execution host this page belongs to. Each host has its own listener origin, so every
 * request, stream and stored draft on this page already belongs to that host; this only names it
 * for the UI and lists the other hosts' origins for switching. */
import { createSignal } from "solid-js"

export type HostLink = { id: string; label: string; origin: string }
/** A host in the Work view: its laptop listener origin, and whether new work goes there by default. */
export type Profile = "work" | "personal"
export type HostKind = "laptop" | "mini" | "pc"
export type WorkHost = HostLink & { default?: boolean; profile?: Profile; kind?: HostKind }
export type HostInfo = { id: string; label: string; remote: boolean; hosts: HostLink[]; work: WorkHost[]; profile?: Profile; kind?: HostKind }

const profileOf = (value: unknown) => (value === "work" || value === "personal" ? { profile: value as Profile } : {})
const kindOf = (value: unknown) => (value === "laptop" || value === "mini" || value === "pc" ? { kind: value as HostKind } : {})

const [info, setInfo] = createSignal<HostInfo>()

export const host = info

/** Read once per page. Older servers without the route are the local host. */
export const readHost = (() => {
  let read: Promise<HostInfo> | undefined
  return () =>
    (read ??= fetch("/__es/host", { cache: "no-store" })
      .then(async (response) => {
        const value: unknown = response.ok && response.headers.get("content-type")?.includes("application/json") ? await response.json() : undefined
        return hostInfo(value)
      })
      .catch(() => hostInfo(undefined))
      .then((value) => {
        setInfo(value)
        return value
      }))
})()

export const hostInfo = (value: unknown): HostInfo => {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const hosts = Array.isArray(record.hosts)
    ? record.hosts.flatMap((item: Record<string, unknown>) =>
        item && typeof item.id === "string" && typeof item.label === "string" && typeof item.origin === "string" && URL.parse(item.origin)
          ? [{ id: item.id, label: item.label, origin: URL.parse(item.origin)!.origin }]
          : [],
      )
    : []
  const work = Array.isArray(record.work)
    ? record.work.flatMap((item: Record<string, unknown>) =>
        item && typeof item.id === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(item.id) && typeof item.label === "string" && typeof item.origin === "string" && URL.parse(item.origin)
          ? [{ id: item.id, label: item.label, origin: URL.parse(item.origin)!.origin, ...profileOf(item.profile), ...kindOf(item.kind), ...(item.default === true ? { default: true } : {}) }]
          : [],
      )
    : []
  if (typeof record.id !== "string" || typeof record.label !== "string") return { id: "local", label: "Local", remote: false, hosts, work }
  return { id: record.id, label: record.label, remote: record.remote === true, hosts, work, ...profileOf(record.profile), ...kindOf(record.kind) }
}

/** The other hosts this page reads as Work feeds: never itself, never a Personal host (its pins, cookies and lists stay
 * apart from Work, and the Local listener does not proxy it). */
export const workFeedHosts = (info: Pick<HostInfo, "id" | "work">) => info.work.filter((item) => item.id !== info.id && item.profile !== "personal")
