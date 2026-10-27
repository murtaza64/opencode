/* The execution host this page belongs to. Each host has its own listener origin, so every
 * request, stream and stored draft on this page already belongs to that host; this only names it
 * for the UI and lists the other hosts' origins for switching. */
import { createSignal } from "solid-js"

export type HostLink = { id: string; label: string; origin: string }
export type HostInfo = { id: string; label: string; remote: boolean; hosts: HostLink[] }

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
  if (typeof record.id !== "string" || typeof record.label !== "string") return { id: "local", label: "Local", remote: false, hosts }
  return { id: record.id, label: record.label, remote: record.remote === true, hosts }
}
