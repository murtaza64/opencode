import { readFile } from "node:fs/promises"
import path from "node:path"

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

export const externalURL = (value: string) => {
  if (value.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(value)) return undefined
  const url = URL.parse(value)
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined
  return url.href
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
      /^\/oc\/(event|global\/event|experimental\/(session|session\/failed|capabilities)|umbrella\/session|session|session\/status|permission|question|config\/providers|agent)$/,
      /^\/oc\/session\/[\w-]+(?:\/(message|input)(?:\/[\w-]+)?|\/todo|\/children)?$/,
      /^\/es\/api\/(editspaces|state|notifications|events|notification-events|issues|issue|docs|doc|search|session-insights|pr-detail|current-work|mail|subscriptions|handoffs|lane-provenance|frontdesk\/memory)$/,
      /^\/es\/api\/attention(?:\/session|\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/,
      /^\/es\/api\/wingman(?:\/transcript)?$/,
    ],
    POST: [
      /^\/oc\/session$/,
      /^\/oc\/session\/[\w-]+\/(prompt_async|abort|fork|input|aside|retry)$/,
      /^\/oc\/(permission|question)\/[\w-]+\/(reply|reject)$/,
      /^\/es\/api\/(refresh|frontdesk|curate|(?:digest|brief)\/[^/]+)$/,
      /^\/es\/api\/handoffs$/,
      /^\/es\/api\/attention\/(?:session|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/commands)$/,
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
