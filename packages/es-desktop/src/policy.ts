import { readFile } from "node:fs/promises"
import path from "node:path"
import { remoteHosts } from "../../es-app/remote-host"

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
  return !!url && url.origin === origin && url.pathname.startsWith("/__surface/")
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

// Only expose the existing es-app surface, not daemon PTYs, shell, config, or file APIs.
export const apiAllowed = (method: string, pathname: string) => {
  const routes: Record<string, RegExp[]> = {
    GET: [
      /^\/oc\/(event|global\/event|experimental\/(session|session\/failed|capabilities|usage\/daily)|umbrella\/session|session|session\/status|permission|question|config\/providers|agent)$/,
      /^\/oc\/session\/[\w-]+(?:\/(message|input)(?:\/[\w-]+)?|\/todo|\/children)?$/,
      /^\/es\/api\/(editspaces|state|notifications|events|notification-events|issues|issue|docs|doc|search|session-insights|pr-detail|current-work|mail|subscriptions|handoffs|lane-provenance|frontdesk\/memory|frontdesk\/ignored-failures|surfaces)$/,
      /^\/es\/api\/attention(?:\/session|\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/,
      // This host's Front desk model and one request's linked conversation (read-only).
      /^\/es\/api\/frontdesk\/(model|conversation)$/,
      /^\/es\/api\/wingman(?:\/transcript)?$/,
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
      /^\/es\/api\/frontdesk\/ignored-failures$/,
      /^\/es\/api\/frontdesk\/deliverables\/seen$/,
      /^\/es\/api\/attention\/(?:session|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:commands|delivery))$/,
      // The operator asks for a fresh brief of one open request.
      /^\/es\/api\/frontdesk\/briefs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/regenerate$/,
    ],
    PATCH: [/^\/oc\/session\/[\w-]+$/, /^\/oc\/session\/[\w-]+\/input\/[\w-]+$/],
    PUT: [/^\/es\/api\/(subscriptions|frontdesk\/memory)$/],
    DELETE: [/^\/oc\/session\/[\w-]+(?:\/(input|aside)\/[\w-]+)?$/, /^\/es\/api\/subscriptions$/],
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
