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

// Only expose the existing es-app surface, not daemon PTYs, shell, config, or file APIs.
export const apiAllowed = (method: string, pathname: string) => {
  const routes: Record<string, RegExp[]> = {
    GET: [
      /^\/oc\/(event|global\/event|experimental\/(session|capabilities)|umbrella\/session|session|session\/status|permission|question|config\/providers|agent)$/,
      /^\/oc\/session\/[\w-]+(?:\/(message|input)(?:\/[\w-]+)?|\/todo)?$/,
      /^\/es\/api\/(editspaces|state|notifications|events|notification-events|issues|issue|docs|doc|search|session-insights|pr-detail|current-work|mail|subscriptions|handoffs)$/,
      /^\/es\/api\/attention(?:\/session|\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/,
      /^\/es\/api\/wingman(?:\/transcript)?$/,
    ],
    POST: [
      /^\/oc\/session$/,
      /^\/oc\/session\/[\w-]+\/(prompt_async|abort|fork|input|aside)$/,
      /^\/oc\/(permission|question)\/[\w-]+\/(reply|reject)$/,
      /^\/es\/api\/(refresh|frontdesk|curate|(?:digest|brief)\/[^/]+)$/,
      /^\/es\/api\/handoffs$/,
      /^\/es\/api\/attention\/(?:session|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/commands)$/,
    ],
    PATCH: [/^\/oc\/session\/[\w-]+$/],
    PUT: [/^\/es\/api\/subscriptions$/],
    DELETE: [/^\/oc\/session\/[\w-]+(?:\/(input|aside)\/[\w-]+)?$/, /^\/es\/api\/subscriptions$/],
  }
  return routes[method]?.some((route) => route.test(pathname)) ?? false
}
