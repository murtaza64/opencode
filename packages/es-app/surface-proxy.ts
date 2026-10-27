/* Front Desk surfaces: agent-maintained views served under the app origin at
 * /__cap/surface/<id>/<capability>/. The dashboard registry names each surface's
 * upstream; this proxy forwards to it without the app's credentials and pins
 * every response into a script-capable sandbox whose network reach is its own
 * prefix. The capability keeps other local pages from reading surface content,
 * and lets the sandboxed (opaque-origin) frame load without ambient cookies.
 *
 * Browsers send no cookies with an opaque-origin frame's subresource requests, so an
 * authenticating edge (Cloudflare Access) in front of the app cannot gate surface content.
 * Everything under /__cap/ is capability-addressed instead: the edge bypasses that one prefix
 * (and rate-limits it), and the path's capability is the whole credential. It is minted only
 * behind the app's own authentication, names one resource, and expires within an hour, so a
 * leaked URL stops working. Other capability-served content (e.g. shared files) belongs under
 * the same prefix so one edge rule covers it. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { request, type IncomingMessage, type ServerResponse } from "node:http"

export type SurfaceEntry = { id: string; upstream: string }

const CAPABILITY = /^\/__es\/surface\/([a-z0-9][a-z0-9-]{0,39})$/
const SURFACE = /^\/__cap\/surface\/([a-z0-9][a-z0-9-]{0,39})\/([0-9a-z]{1,12})-([0-9a-f]{32})(\/.*)$/
const CAPABILITY_TTL = 3600_000
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
// Forward only content negotiation and payload shape; never cookies, auth, origin or app keys.
const REQUEST_HEADERS = ["accept", "accept-language", "content-type", "content-length", "if-none-match", "if-modified-since", "last-event-id"]
const RESPONSE_HEADERS = ["content-type", "content-length", "content-encoding", "last-modified", "etag"]
const REGISTRY_TTL = 3000

/** The edge-bypassed prefix: only capability-checked handlers may serve paths under it. */
export const CAPABILITY_PREFIX = "/__cap/"
export const isSurfacePath = (pathname: string) => pathname.startsWith(CAPABILITY_PREFIX) || CAPABILITY.test(pathname)

export const surfaceCsp = (prefix: string) =>
  [
    "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox",
    "default-src 'none'",
    `script-src ${prefix} 'unsafe-inline'`,
    `style-src ${prefix} 'unsafe-inline'`,
    `img-src ${prefix} data: blob:`,
    `font-src ${prefix} data:`,
    `media-src ${prefix} blob:`,
    `connect-src ${prefix}`,
    `form-action ${prefix}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ")

// publicOrigin: the browser-facing origin when a proxy (e.g. Tailscale Serve) fronts this
// gateway; the Host reaching us is then loopback, so the frame needs the public prefix too.
export const surfaceProxy = (options: {
  dashboard: string | undefined
  registry?: () => Promise<SurfaceEntry[]>
  publicOrigin?: string
  /** Lifetime of a minted frame address; the desk remounts the frame before it lapses. */
  capabilityTtl?: number
  now?: () => number
}) => {
  const key = randomBytes(32)
  const now = options.now ?? Date.now
  const ttl = options.capabilityTtl ?? CAPABILITY_TTL
  // The expiry is part of the signed message, so it cannot be extended by editing the path.
  const mac = (id: string, expiry: string) => createHmac("sha256", key).update(`${id}|${expiry}`).digest("hex").slice(0, 32)
  const capability = (id: string, expiresAt = now() + ttl) => {
    const expiry = Math.ceil(expiresAt / 1000).toString(36)
    return { token: `${expiry}-${mac(id, expiry)}`, expiresAt: parseInt(expiry, 36) * 1000 }
  }
  let cached: { at: number; value: Promise<SurfaceEntry[]> } | undefined
  const registry =
    options.registry ??
    (() => {
      if (cached && Date.now() - cached.at < REGISTRY_TTL) return cached.value
      const value = fetch(`${options.dashboard}/api/surfaces`, { signal: AbortSignal.timeout(5000), redirect: "error" })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`registry ${response.status}`))))
        .then((body: { surfaces: SurfaceEntry[] }) => body.surfaces)
      value.catch(() => (cached = undefined))
      cached = { at: Date.now(), value }
      return value
    })
  const upstreamURL = (entry: SurfaceEntry, rest: string, search: string) => {
    const base = entry.upstream.startsWith("/") ? new URL(entry.upstream, options.dashboard) : new URL(entry.upstream)
    if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) return undefined
    // Concatenate rather than resolve: the surface may not climb out of its upstream base.
    if (rest.split("/").includes("..")) return undefined
    return `${base.origin}${base.pathname.replace(/\/$/, "")}${rest}${search}`
  }

  /** The iframe address for a surface. Callers must authenticate the request as the app first. */
  const address = (req: IncomingMessage, res: ServerResponse) => {
    const match = CAPABILITY.exec(new URL(req.url ?? "/", "http://surface").pathname)
    if (!match || req.method !== "GET" || req.headers["sec-fetch-site"] === "cross-site") return finish(res, 403, "Forbidden")
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
    const minted = capability(match[1])
    res.end(JSON.stringify({ src: `/__cap/surface/${match[1]}/${minted.token}/`, expires_at: minted.expiresAt }))
  }

  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://surface")
    const match = SURFACE.exec(url.pathname)
    if (!match || !(METHODS.has(req.method ?? "") || req.method === "OPTIONS")) return finish(res, 404, "Not found")
    const [, id, expiry, signature, rest] = match
    // Wrong, foreign and expired capabilities answer the same plain 404, never a login page.
    if (parseInt(expiry, 36) * 1000 <= now() || !timingSafeEqual(Buffer.from(signature), Buffer.from(mac(id, expiry))))
      return finish(res, 404, "Not found")
    const presented = `${expiry}-${signature}`
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "null",
        "access-control-allow-methods": [...METHODS].join(", "),
        "access-control-allow-headers": "accept, content-type, last-event-id",
        "access-control-max-age": "600",
      })
      return res.end()
    }
    const entry = await registry()
      .then((list) => list.find((item) => item.id === id))
      .catch(() => null)
    if (entry === null) return finish(res, 502, "Surface registry unavailable")
    if (!entry) return finish(res, 404, "Surface withdrawn")
    const target = upstreamURL(entry, rest, url.search)
    if (!target) return finish(res, 400, "Invalid surface path")
    const path = `/__cap/surface/${id}/${presented}/`
    const prefix = [`http://${req.headers.host}${path}`, ...(options.publicOrigin ? [`${options.publicOrigin}${path}`] : [])].join(" ")
    const upstream = request(
      target,
      {
        method: req.method,
        headers: Object.fromEntries(REQUEST_HEADERS.flatMap((name) => (req.headers[name] ? [[name, req.headers[name]]] : []))),
      },
      (response) => {
        const status = response.statusCode ?? 502
        if (status >= 300 && status < 400 && status !== 304) {
          response.resume()
          return finish(res, 502, "Surface redirects are not supported; use relative links")
        }
        res.writeHead(status, {
          ...Object.fromEntries(RESPONSE_HEADERS.flatMap((name) => (response.headers[name] ? [[name, response.headers[name]]] : []))),
          "content-security-policy": surfaceCsp(prefix),
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "cache-control": "no-store",
          // The sandboxed frame has an opaque origin; only capability holders reach this response.
          "access-control-allow-origin": "null",
        })
        response.on("error", () => res.destroy())
        response.pipe(res)
      },
    )
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("Surface idle timeout")))
    upstream.on("error", () => (res.headersSent ? res.destroy() : finish(res, 502, "Surface unreachable")))
    res.on("close", () => upstream.destroy())
    req.pipe(upstream)
  }

  return { address, serve, capability }
}

const finish = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
  res.end(body)
}
