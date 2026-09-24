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
      /^\/oc\/session\/[\w-]+(?:\/(message|input)(?:\/[\w-]+)?)?$/,
      /^\/es\/api\/(editspaces|state|notifications|events|notification-events|issues|issue|docs|doc|search)$/,
    ],
    POST: [
      /^\/oc\/session$/,
      /^\/oc\/session\/[\w-]+\/(prompt_async|abort|fork|input|aside)$/,
      /^\/oc\/(permission|question)\/[\w-]+\/(reply|reject)$/,
      /^\/es\/api\/(refresh|frontdesk|curate|(?:digest|brief)\/[^/]+)$/,
    ],
    PATCH: [/^\/oc\/session\/[\w-]+$/],
    DELETE: [/^\/oc\/session\/[\w-]+(?:\/(input|aside)\/[\w-]+)?$/],
  }
  return routes[method]?.some((route) => route.test(pathname)) ?? false
}
