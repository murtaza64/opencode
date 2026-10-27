/* Execution hosts for the laptop proxies (vite web and the es-desktop native server).
 * Each host is served by its own loopback listener, so browser storage, drafts, receipts and
 * caches are isolated by origin and a listener's upstream never changes after startup. A remote
 * host is an allowlisted tailnet HTTPS origin whose root is its Core and whose /es is its
 * dashboard; its identity gate authenticates the laptop's tailnet user, so no credential is sent. */

export type HostLink = { id: string; label: string; origin: string }
/** What a listener reports to the app at /__es/host. */
export type HostInfo = { id: string; label: string; remote: boolean; hosts: HostLink[] }

export const localHost: HostInfo = { id: "local", label: "Local", remote: false, hosts: [] }

const ID = /^[a-z][a-z0-9-]{0,31}$/

/** A remote host's public origin: https on a tailnet name, no credentials, path or port. */
export const remoteOrigin = (value: unknown) => {
  const url = typeof value === "string" ? URL.parse(value) : null
  if (
    !url ||
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".ts.net") ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Remote hosts must be https://<name>.ts.net origins")
  return url.origin
}

/** A host whose own served page is shown as-is (e.g. behind Cloudflare Access): https, no credentials. */
export const pageOrigin = (value: unknown) => {
  const url = typeof value === "string" ? URL.parse(value) : null
  if (!url || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Page hosts must be https origins")
  return url.origin
}

/** How a host is reached: "proxy" serves this machine's app against its Core and dashboard through a
 * laptop listener; "page" shows the host's own served page in an unprivileged, isolated view. */
export type RemoteHost = HostLink & { mode: "proxy" | "page" }

/** Configured remote hosts: [{ id, label, origin, mode? }] with distinct ids other than "local". */
export const remoteHosts = (value: unknown): RemoteHost[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("Remote hosts must be a list")
  const hosts = value.map((item) => {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {}
    if (typeof record.id !== "string" || !ID.test(record.id) || record.id === "local") throw new Error("Invalid remote host id")
    const label = typeof record.label === "string" && record.label.trim() ? record.label.trim().slice(0, 40) : record.id
    const mode = record.mode === "page" ? "page" : "proxy"
    return { id: record.id, label, origin: mode === "page" ? pageOrigin(record.origin) : remoteOrigin(record.origin), mode } as RemoteHost
  })
  if (new Set(hosts.map((host) => host.id)).size !== hosts.length) throw new Error("Duplicate remote host id")
  return hosts
}

/** Upstreams for one host's listener: the Core at the root, the dashboard under /es. */
export const remoteTargets = (origin: string) => ({ opencode: origin, dashboard: `${origin}/es` })

// Routes the dashboard authorizes with the operator cookie: attention and the Front desk's own files.
export const attentionRoute = /^\/es\/api\/(?:attention(?:\/|$)|frontdesk\/(?:memory|ignored-failures|deliverables\/seen)$)/

const OPERATOR = "es_attention_operator"
// Cookies ignore ports, so every loopback listener sees every host's cookies: give each remote
// host's operator cookie its own name so hosts never present each other's operator session.
const operatorCookie = (id: string) => `${OPERATOR}__${id}`

/** The upstream Cookie header for a remote host: only that host's operator cookie, under the dashboard's name. */
export const remoteCookie = (header: string | undefined, id: string) => {
  const name = `${operatorCookie(id)}=`
  const value = header?.split(";").map((item) => item.trim()).find((item) => item.startsWith(name))
  return value ? `${OPERATOR}=${value.slice(name.length)}` : undefined
}

/** The browser Set-Cookie values for a remote host: only the operator cookie, renamed for that host. */
export const remoteSetCookie = (values: string[] | undefined, id: string) => {
  const renamed = (values ?? [])
    .filter((value) => value.startsWith(`${OPERATOR}=`))
    .map((value) => operatorCookie(id) + value.slice(OPERATOR.length))
  return renamed.length ? renamed : undefined
}
