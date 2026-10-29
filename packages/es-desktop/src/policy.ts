import { readFile } from "node:fs/promises"
import path from "node:path"
import { hostIdentity, remoteHosts } from "../../es-app/remote-host"

export const serviceURL = (value: string | undefined) => {
  if (!value) return undefined
  const url = new URL(value)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Service targets must be explicit http://127.0.0.1:PORT origins")
  return url.origin
}

export const serviceOrigins = async (
  directory: string,
  env: { OPENCODE_URL?: string; ES_DASHBOARD_URL?: string },
) => {
  const content = await readFile(path.join(directory, "service-origins.json"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}"
      throw error
    },
  )
  const saved: unknown = JSON.parse(content)
  const configured = saved && typeof saved === "object" && !Array.isArray(saved)
    ? saved as Record<string, unknown>
    : {}
  return {
    opencode: serviceURL(env.OPENCODE_URL || (typeof configured.opencode === "string" ? configured.opencode : undefined)),
    dashboard: serviceURL(env.ES_DASHBOARD_URL || (typeof configured.dashboard === "string" ? configured.dashboard : undefined)),
  }
}

/** Remote execution hosts from ES_REMOTE_HOSTS or service-origins.json "hosts" (validated tailnet origins). */
export const serviceHosts = async (directory: string, env: { ES_REMOTE_HOSTS?: string }) => {
  if (env.ES_REMOTE_HOSTS) return remoteHosts(JSON.parse(env.ES_REMOTE_HOSTS))
  const content = await readFile(path.join(directory, "service-origins.json"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}"
      throw error
    },
  )
  const saved: unknown = JSON.parse(content)
  return remoteHosts(saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, unknown>).hosts : undefined)
}

/** This machine's own identity from service-origins.json "self" ({ id, label?, profile?, kind? }); absent = "local". */
export const serviceSelf = async (directory: string) => {
  const content = await readFile(path.join(directory, "service-origins.json"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}"
      throw error
    },
  )
  const saved: unknown = JSON.parse(content)
  return hostIdentity(saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, unknown>).self : undefined)
}

export const externalURL = (value: string) => {
  if (value.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(value)) return undefined
  const url = URL.parse(value)
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined
  return url.href
}

// Sign-in services a page host may pass through (Cloudflare Access and its identity providers). The
// whole round trip must stay in the tab's partition: Access binds its OAuth state to the session that
// started sign-in, so finishing a provider step in another browser ends at "invalid state".
// dash.cloudflare.com is Access's "Cloudflare" identity provider (its OAuth authorize page).
const SIGN_IN = [/\.cloudflareaccess\.com$/, /^dash\.cloudflare\.com$/, /^accounts\.google\.com$/, /^github\.com$/]

/** Whether a page host's tab may navigate in place: its own origin, or a secure sign-in step. */
export const pageNavigation = (value: string, origin: string) => {
  const url = URL.parse(value)
  if (!url || url.username || url.password) return false
  if (url.origin === origin) return true
  return url.protocol === "https:" && SIGN_IN.some((pattern) => pattern.test(url.hostname))
}

// Site of a URL for cookie purposes: scheme + registrable-domain approximation (last two labels; IPs whole).
const siteOf = (value: string) => {
  const url = URL.parse(value)
  if (!url) return undefined
  const host = url.hostname
  const domain = /^[\d.]+$|:/.test(host) ? host : host.split(".").slice(-2).join(".")
  return `${url.protocol}//${domain}`
}

/** True when a page host tab has just arrived on its own origin from another site (e.g. a sign-in
 * service). SameSite=Strict cookies are withheld on that navigation, so the page sees itself signed
 * out; one reload from the same site sends them. */
export const pageArrivedCrossSite = (previous: string | undefined, next: string, origin: string) =>
  URL.parse(next)?.origin === origin && !!previous && !previous.startsWith("data:") && siteOf(previous) !== siteOf(next)

export const surfaceFrameURL = (value: string, origin: string) => {
  const url = URL.parse(value)
  return !!url && url.origin === origin && url.pathname.startsWith("/__cap/")
}

export const internalURL = (value: string, origin: string) => {
  const url = URL.parse(value)
  return !!url && url.origin === origin && !/^\/(oc|es)(\/|$)/.test(url.pathname)
}

// Published web (3181), dev (3100) and native (60302) serve the same es-app, so a link to an app route
// on any of them opens that route in this window rather than an external browser.
const APP_PORTS = ["3181", "3100", "60302"]
const APP_ROUTE = /^\/(?:|cloud|map|new|desk|issue|doc|session\/[\w-]+)$/

export const appRouteURL = (value: string, origin: string) => {
  const url = URL.parse(value)
  if (!url || url.username || url.password || !APP_ROUTE.test(url.pathname)) return undefined
  const known = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && APP_PORTS.includes(url.port)
  if (url.origin !== origin && !known) return undefined
  return new URL(url.pathname + url.search + url.hash, origin).href
}

/**
 * A launch restore (ES_DESKTOP_RESTORE): which host views were open, where, and which was shown, as a publisher
 * captured them before a graceful quit. An app view reopens on an app route of its own listener origin (stable saved
 * ports); a page view (another site, e.g. Personal) on a URL of its own configured origin, the navigation its guard
 * already allows, kept verbatim. `created: true` reopens a view on its start page without recording a URL. Nothing
 * opens another host or a non-app route. Undefined, restoring nothing, unless the whole record is valid.
 */
export const restorePlan = (value: unknown, tabs: readonly { id: string; origin: string; kind?: "app" | "page"; start?: string }[]) => {
  if (!value || typeof value !== "object") return undefined
  const record = value as { version?: unknown; selected?: unknown; views?: unknown }
  if (record.version !== 1 || !Array.isArray(record.views) || !record.views.length || record.views.length > tabs.length) return undefined
  const views = record.views.map((item: { id?: unknown; url?: unknown; created?: unknown }) => {
    const tab = tabs.find((candidate) => candidate.id === item?.id)
    if (!tab) return undefined
    if (item.created !== undefined) return item.created === true && item.url === undefined ? { id: tab.id, url: tab.start ?? `${tab.origin}/` } : undefined
    if (typeof item.url !== "string") return undefined
    const parsed = URL.parse(item.url)
    if (!parsed || parsed.origin !== tab.origin || parsed.username || parsed.password) return undefined
    const url = tab.kind === "page" ? parsed.href : appRouteURL(item.url, tab.origin)
    return url ? { id: tab.id, url } : undefined
  })
  if (views.some((item) => !item) || new Set(views.map((item) => item!.id)).size !== views.length) return undefined
  if (typeof record.selected !== "string" || !views.some((item) => item!.id === record.selected)) return undefined
  return { selected: record.selected, views: views as { id: string; url: string }[] }
}

// Work view reads of another host through this laptop's listener (/hosts/<id>/...): its session
// list and statuses, handoff lineage and lane owners (so a pin follows a handoff on that host), one
// session's record, messages and todos (read-only view in the Local window),
// daily usage rollup (the Today total), editspace names and open-decision list (which the dashboard serves without an operator).
// Everything else about that host, answering and operator sessions included, stays on its own tab,
// origin and operator cookie.
export const hostApiAllowed = (method: string, pathname: string) =>
  ["GET", "HEAD"].includes(method) && (/^\/es\/api\/handoffs\/self\/[A-Za-z0-9_-]{1,128}$/.test(pathname) || /^\/(?:oc\/experimental\/(?:session|usage\/daily|capabilities)|oc\/session\/status|oc\/session\/[\w-]+(?:\/todo|\/children|\/message(?:\/[\w-]+)?|\/input(?:\/[\w-]+)?)?|oc\/(?:permission|question)|oc\/config\/providers|es\/api\/(?:editspaces|state|handoffs|attention|attention\/session|attention\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|pins|pins\/events))$/.test(pathname))

// One shared pin's ref in a single path segment, as the browser sends it (a lane's slash encoded once).
const PIN_REF = "(?:session:[A-Za-z0-9_-]{1,128}|lane:[A-Za-z0-9._-]{1,64}%2[Ff][A-Za-z0-9._-]{1,64})"
const SELF_HANDOFF = /^\/es\/api\/handoffs\/self\/[A-Za-z0-9_-]{1,128}$/
// Same operator-cookie boundary as attention writes, but never through /hosts/<id>/ writes.
export const selfHandoffRoute = /^\/es\/api\/handoffs\/self(?:\/[A-Za-z0-9_-]{1,128})?$/

// Writes to another Work host from this laptop's window (/hosts/<id>/...), Slice W (contract v0.2.1 §4):
// the same session writes this listener allows on its own host (prompt/input admission, pending-input
// edit/withdraw/deliver, recovery nudge, stop, Aside ask/cancel, the session model preference), permission
// and question replies, and attention operator sign-in, answers and delivery checks. Fork, create and delete
// stay on that host's own window. Pin writes (`hostPinWrite`) reach only that host's own store.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const HOST_WRITES: Record<string, RegExp> = {
  POST: new RegExp(`^/(?:oc/session/[\\w-]+/(?:prompt_async|input|abort|recover|aside)|oc/session/[\\w-]+/input/[\\w-]+/deliver|oc/(?:permission|question)/[\\w-]+/(?:reply|reject)|es/api/attention/(?:session|${UUID}/(?:commands|delivery)))$`),
  PATCH: /^\/oc\/session\/[\w-]+(?:\/input\/[\w-]+)?$/,
  DELETE: /^\/oc\/session\/[\w-]+\/(?:input|aside)\/[\w-]+$/,
}
// Pin writes to another Work host's own store (contract v0.2.2 §3): pin, unpin and reorder of one encoded ref, so the
// Work view changes that host's pin in place. Same operator-cookie, CSRF and native-origin boundary as attention answers.
const HOST_PIN_WRITES: Record<string, RegExp> = {
  PUT: new RegExp(`^/es/api/pins/${PIN_REF}$`),
  DELETE: new RegExp(`^/es/api/pins/${PIN_REF}$`),
  PATCH: new RegExp(`^/es/api/pins/${PIN_REF}/order$`),
}
export const hostPinWrite = (method: string, pathname: string) => HOST_PIN_WRITES[method]?.test(pathname) ?? false

export const hostWriteAllowed = (method: string, pathname: string) => (HOST_WRITES[method]?.test(pathname) ?? false) || hostPinWrite(method, pathname)

/** Another host's attention routes, which its dashboard authorizes with that host's operator cookie. */
export const hostAttention = (pathname: string) => new RegExp(`^/es/api/attention/(?:session|${UUID}(?:/commands|/delivery)?)$`).test(pathname)

// Only expose the existing es-app surface, not daemon PTYs, shell, config, or file APIs.
export const apiAllowed = (method: string, pathname: string) => {
  const routes: Record<string, RegExp[]> = {
    GET: [
      /^\/oc\/(event|global\/event|experimental\/(session|session\/failed|capabilities|usage\/daily|usage\/sessions)|umbrella\/session|session|session\/status|permission|question|config\/providers|agent)$/,
      /^\/oc\/session\/[\w-]+(?:\/(message|input)(?:\/[\w-]+)?|\/todo|\/children)?$/,
      // One completed tool part's large attachment (an image or file a tool returned), fetched lazily
      // by its index instead of inline in the message page. Read-only; Core checks the part's session.
      /^\/oc\/session\/[\w-]+\/message\/[\w-]+\/part\/[\w-]+\/attachment\/\d{1,4}$/,
      /^\/es\/api\/(editspaces|state|notifications|events|notification-events|issues|issue|docs|doc|search|session-insights|pr-detail|current-work|mail|wake-events|subscriptions|handoffs|lane-provenance|frontdesk\/memory|frontdesk\/ignored-failures|surfaces|pins|pins\/events)$/,
      /^\/es\/api\/surfaces\/[a-z0-9][a-z0-9-]{0,39}\/snapshot$/,
      /^\/es\/api\/attention(?:\/session|\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/,
      // This host's Front desk model and one request's linked conversation (read-only).
      /^\/es\/api\/frontdesk\/(model|conversation)$/,
      // One brief's saved rating (?job=) or every rating for export; read-only.
      /^\/es\/api\/frontdesk\/brief-feedback$/,
      // This host's Front Desk cases (metadata only); read-only.
      /^\/es\/api\/frontdesk\/cases$/,
      /^\/es\/api\/wingman(?:\/transcript)?$/,
      SELF_HANDOFF,
    ],
    POST: [
      /^\/oc\/session$/,
      /^\/oc\/session\/[\w-]+\/(prompt_async|abort|fork|input|aside|retry)$/,
      // Interrupt and steer now: deliver one pending steer; Nudge on an interrupted step: recover.
      /^\/oc\/session\/[\w-]+\/input\/[\w-]+\/deliver$/,
      /^\/oc\/session\/[\w-]+\/recover$/,
      /^\/oc\/(permission|question)\/[\w-]+\/(reply|reject)$/,
      /^\/es\/api\/(refresh|frontdesk|curate|(?:digest|brief)\/[^/]+)$/,
      /^\/es\/api\/handoffs$/,
      /^\/es\/api\/handoffs\/self$/,
      /^\/es\/api\/frontdesk\/ignored-failures$/,
      /^\/es\/api\/frontdesk\/deliverables\/seen$/,
      // The operator rates one prepared brief; the dashboard checks operator, CSRF and that it is a brief.
      /^\/es\/api\/frontdesk\/brief-feedback$/,
      // One masked decision field's single submission; the dashboard checks handle, operator, origin and scope.
      /^\/es\/api\/secret-intake\/[\w-]+$/,
      /^\/es\/api\/attention\/(?:session|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:commands|delivery))$/,
      // The operator asks for a fresh brief of one open request.
      /^\/es\/api\/frontdesk\/briefs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/regenerate$/,
    ],
    PATCH: [/^\/oc\/session\/[\w-]+$/, /^\/oc\/session\/[\w-]+\/input\/[\w-]+$/, new RegExp(`^/es/api/pins/${PIN_REF}/order$`)],
    PUT: [/^\/es\/api\/(subscriptions|frontdesk\/memory)$/, new RegExp(`^/es/api/pins/${PIN_REF}$`)],
    DELETE: [/^\/oc\/session\/[\w-]+(?:\/(input|aside)\/[\w-]+)?$/, /^\/es\/api\/subscriptions$/, new RegExp(`^/es/api/pins/${PIN_REF}$`), SELF_HANDOFF],
  }
  return routes[method]?.some((route) => route.test(pathname)) ?? false
}

/**
 * Opt-in startup for launches the user did not initiate (publisher relaunch, automated checks).
 * Unset or unknown values keep ordinary launches unchanged. On macOS the accessory policy is set
 * before the app finishes launching and no window is shown or focused, so startup does not ask to
 * become the active app; showing a window would, so that waits for an explicit user reopen.
 * - background: no window or dock icon until the user relaunches/reopens the running Editspace,
 *   then the ordinary window appears and the app becomes a regular app.
 * - hidden: never shown, even on reopen; automated verification only.
 */
export type StartupMode = "normal" | "background" | "hidden"

export const startupMode = (value: string | undefined): StartupMode =>
  value === "background" || value === "hidden" ? value : "normal"

export const startupPlan = (mode: StartupMode) => ({
  // macOS activation policy applied before app ready; undefined leaves the default (regular).
  activationPolicy: mode === "normal" ? undefined : ("accessory" as const),
  showOnLoad: mode === "normal",
  revealOnReopen: mode !== "hidden",
  // A never-shown verification window must keep timers and rendering live.
  backgroundThrottling: mode !== "hidden",
})
