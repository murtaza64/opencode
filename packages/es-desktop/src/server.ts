import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { createReadStream } from "node:fs"
import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { apiAllowed, serviceURL } from "./policy"
import { cookieName, cookieValid, issueCookie, loopbackHost, pairingCsp, pairingMatches, pairingPage, remoteListenHost } from "./pairing"
import { eventMux } from "../../es-app/event-mux"
import { eventProtocol, eventPaths } from "../../es-app/event-protocol"
import { surfaceProxy } from "../../es-app/surface-proxy"
import type { Voice } from "./voice"

const csp =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const offline = `<!doctype html><html lang="en" dir="ltr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="5"><title>Editspace unavailable</title><style>body{font:16px system-ui;background:#171819;color:#ececec;margin:0;padding:10vh 8vw}main{max-inline-size:42rem}h1{font-size:28px}p{line-height:1.6;color:#bbb}a{color:#9ac9ff}code{direction:ltr;unicode-bidi:isolate}</style><main><h1>Services unavailable</h1><p>Editspace attaches to existing services. It does not start or stop them.</p><p>Configure loopback origins in <code>service-origins.json</code> in the Editspace profile or launch with explicit <code>OPENCODE_URL</code> and <code>ES_DASHBOARD_URL</code>. For an isolated demo, run <code>bun run preview</code> from the es-desktop package.</p><p>Retrying every 5 seconds. <a href="/">Retry now</a>.</p></main></html>`
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
}

// Do not forward browser credentials or hop-by-hop headers to attached services.
const proxyHeaders = (headers: IncomingHttpHeaders) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) =>
        !new Set([
          "host",
          "connection",
          "keep-alive",
          "transfer-encoding",
          "upgrade",
          "te",
          "trailer",
          "proxy-authorization",
          "proxy-authenticate",
          "cookie",
          "authorization",
          "origin",
          "referer",
          "x-editspace-key",
          "set-cookie",
          "access-control-allow-origin",
          "content-security-policy",
          "cache-control",
          "if-none-match",
          "if-modified-since",
          ...(headers.connection ?? "").toLowerCase().split(/\s*,\s*/),
        ]).has(key),
    ),
  )

export const serve = async (options: {
  root: string
  opencode?: string
  dashboard?: string
  renderer?: string
  opencodeAuth?: string
  port?: number
  // Remote (Android) mode: listen on an explicit loopback/tailnet host and
  // authenticate with a pairing cookie instead of the native capability header.
  host?: string
  pairing?: { code: string; maxAgeSeconds?: number }
  // Native-only operator dictation; paired remote clients never reach this host's microphone.
  voice?: Voice
}) => {
  const host = options.host ? remoteListenHost(options.host) : "127.0.0.1"
  if (!host) throw new Error("Remote listeners must bind loopback or a tailnet address")
  if (!loopbackHost(host) && !options.pairing) throw new Error("Non-loopback listeners require pairing")
  const pairing = options.pairing
  const failures = { count: 0, since: 0 }
  const targets = { oc: serviceURL(options.opencode), es: serviceURL(options.dashboard) }
  const renderer = serviceURL(options.renderer)
  const root = await realpath(options.root)
  const index = renderer ? undefined : await readFile(path.join(root, "index.html"))
  const key = randomBytes(32).toString("hex")
  const upstreams = new Set<ReturnType<typeof request>>()
  const surfaces = surfaceProxy({ dashboard: targets.es })
  const sameHost = (req: { headers: IncomingHttpHeaders }) => req.headers.host === new URL(origin).host
  const allowed = (req: { headers: IncomingHttpHeaders; method?: string }) =>
    sameHost(req) &&
    (pairing
      ? cookieValid(pairing.code, req.headers) &&
        // SameSite ignores ports, so other local origins also carry the cookie:
        // require same-origin fetch metadata, and the page origin for writes.
        [undefined, "same-origin", "none"].includes(req.headers["sec-fetch-site"] as string | undefined) &&
        (["GET", "HEAD"].includes(req.method ?? "") || req.headers.origin === origin)
      : req.headers["x-editspace-key"] === key) &&
    (!req.headers.origin || req.headers.origin === origin) &&
    req.headers["sec-fetch-site"] !== "cross-site"
  // Unpaired same-host requests: health probe, pairing form, or a 401 the shell can act on.
  const pair = async (
    req: IncomingMessage,
    res: ServerResponse,
    finish: (status: number, body: string, type?: string) => void,
  ) => {
    if (!pairing) return finish(403, "Forbidden")
    const url = new URL(req.url ?? "/", origin)
    if (url.pathname === "/__es/health" && req.method === "GET")
      return finish(200, JSON.stringify({ service: "editspace", pairing: true }), "application/json")
    const page = (status: number, error?: string) => {
      res.setHeader("Content-Security-Policy", pairingCsp)
      finish(status, pairingPage(error), "text/html; charset=utf-8")
    }
    if (url.pathname !== "/__es/pair" || req.method !== "POST") {
      if (req.method === "GET" && (req.headers["sec-fetch-dest"] === "document" || req.headers.accept?.includes("text/html")))
        return page(401)
      return finish(401, JSON.stringify({ error: "Pairing required" }), "application/json")
    }
    if (req.headers["sec-fetch-site"] === "cross-site" || ![undefined, "null", origin].includes(req.headers.origin))
      return finish(403, "Forbidden")
    const now = Date.now()
    if (now - failures.since > 60_000) Object.assign(failures, { count: 0, since: now })
    if (failures.count >= 10) return page(429, "Too many attempts. Wait a minute and try again.")
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 1024) return finish(413, "Payload too large")
      chunks.push(chunk)
    }
    const code = new URLSearchParams(Buffer.concat(chunks).toString()).get("code") ?? ""
    if (!pairingMatches(pairing.code, code)) {
      failures.count++
      return page(401, "That code does not match. Check the gateway output and try again.")
    }
    res.writeHead(303, {
      location: "/",
      "set-cookie": `${cookieName}=${issueCookie(pairing.code)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${pairing.maxAgeSeconds ?? 30 * 86400}`,
    })
    res.end()
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", csp)
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("Referrer-Policy", "no-referrer")
    res.setHeader("Cache-Control", "no-store")
    const finish = (status: number, body: string, type = "text/plain") => {
      res.writeHead(status, { "content-type": type })
      res.end(body)
    }
    // Surface frames are opaque-origin sandboxes without the app's cookie or key; their
    // per-surface capability path is the only credential they carry.
    if (sameHost(req) && req.url?.startsWith("/__surface/")) {
      if (!targets.es) return finish(503, "Service not configured")
      res.removeHeader("Content-Security-Policy")
      return void surfaces.serve(req, res)
    }
    if (pairing && sameHost(req) && (!allowed(req) || /^\/__es\/(pair|health)(\?|$)/.test(req.url ?? "")))
      return pair(req, res, finish)
    if (!allowed(req)) {
      finish(403, "Forbidden")
      return
    }
    const url = new URL(req.url ?? "/", origin)
    if (url.origin !== origin) return finish(403, "Forbidden")
    if (url.pathname === "/__es/events") {
      if (req.method !== "GET" || url.search) return finish(403, "Forbidden")
      return finish(200, JSON.stringify({ protocol: eventProtocol }), "application/json")
    }
    if (url.pathname.startsWith("/__es/surface/")) return surfaces.address(req, res)
    if (/^\/__es\/voice(\/|$)/.test(url.pathname)) {
      if (!options.voice || pairing || url.search) return finish(404, "Not found")
      return voiceRoute(options.voice, req, url.pathname, origin, finish)
    }
    const api = /^\/(oc|es)(\/|$)/.exec(url.pathname)
    if (api && !apiAllowed(req.method ?? "", url.pathname)) return finish(403, "API route not exposed")
    // Routes the dashboard authorizes with the operator cookie: attention and the Front desk's own files.
    const attention = /^\/es\/api\/(?:attention(?:\/|$)|frontdesk\/(?:memory|ignored-failures|deliverables\/seen)$)/.test(url.pathname)
    if (attention && req.method !== "GET" && req.headers.origin !== origin)
      return finish(403, "Attention writes require the native origin")
    const target = api ? targets[api[1] as keyof typeof targets] : renderer
    if (api && !target) return finish(503, '{"error":"Service not configured"}', "application/json")
    if (!api && !["GET", "HEAD"].includes(req.method ?? "")) return finish(405, "Method not allowed")
    if (!api && (req.headers["sec-fetch-dest"] === "document" || url.pathname === "/")) {
      const ready = await Promise.all(
        [targets.oc && `${targets.oc}/experimental/capabilities`, targets.es && `${targets.es}/api/editspaces`].map(
          (value, index) =>
            value
              ? fetch(value, {
                  // A loaded Core can take seconds to answer; a stopped one refuses at once.
                  signal: AbortSignal.timeout(10_000),
                  redirect: "error",
                  headers: index === 0 && options.opencodeAuth ? { authorization: options.opencodeAuth } : {},
                })
                  .then(async (response) => {
                    await response.body?.cancel()
                    return response.ok
                  })
                  .catch(() => false)
              : false,
        ),
      )
      if (ready.some((value) => !value)) return finish(503, offline, "text/html; charset=utf-8")
    }
    if (target) {
      const operatorCookie = attention ? req.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("es_attention_operator=")) : undefined
      // Concatenate the path rather than resolving it: //host must never switch upstreams.
      const upstream = request(
        `${target}${api ? url.pathname.slice(api[1].length + 1) || "/" : url.pathname}${url.search}`,
        {
          method: req.method,
          headers: {
            ...proxyHeaders(req.headers),
            // The keyed listener has authenticated the dynamic native origin above.
            // Bind it to the configured dashboard origin; never wildcard local ports.
            ...(attention ? {
              origin: target,
              ...(operatorCookie ? { cookie: operatorCookie } : {}),
            } : {}),
            ...(api?.[1] === "oc" && options.opencodeAuth ? { authorization: options.opencodeAuth } : {}),
          },
        },
        (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
            response.resume()
            return finish(502, '{"error":"Upstream redirect blocked"}', "application/json")
          }
          res.writeHead(response.statusCode ?? 502, {
            ...proxyHeaders(response.headers),
            ...(attention && response.headers["set-cookie"]?.some(value => value.startsWith("es_attention_operator="))
              ? { "set-cookie": response.headers["set-cookie"].filter(value => value.startsWith("es_attention_operator=")) }
              : {}),
          })
          response.on("error", () => res.destroy())
          response.pipe(res)
        },
      )
      upstreams.add(upstream)
      upstream.on("close", () => upstreams.delete(upstream))
      upstream.setTimeout(api ? 15 * 60_000 : 30_000, () => upstream.destroy(new Error("Upstream idle timeout")))
      upstream.on("error", () => {
        if (res.headersSent) return res.destroy()
        finish(502, '{"error":"Attached service unavailable"}', "application/json")
      })
      res.on("close", () => upstream.destroy())
      req.pipe(upstream)
      return
    }
    const decoded = (() => {
      try {
        return decodeURIComponent(url.pathname)
      } catch {
        return undefined
      }
    })()
    if (!decoded || decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes(".."))
      return finish(400, "Invalid path")
    const requested = path.resolve(root, `.${decoded}`)
    const file = await realpath(requested).catch(() => undefined)
    if (file && file !== root && !file.startsWith(`${root}${path.sep}`)) return finish(403, "Forbidden")
    const exists =
      file &&
      (await stat(file)
        .then((value) => value.isFile())
        .catch(() => false))
    const fallback = !path.extname(decoded) && !decoded.startsWith("/assets/")
    if (!exists && !fallback) return finish(404, "Not found")
    const asset = exists ? file : path.join(root, "index.html")
    res.setHeader("Content-Type", types[path.extname(asset)] ?? "application/octet-stream")
    if (req.method === "HEAD") return res.end()
    if (index && asset === path.join(root, "index.html")) return res.end(index)
    const stream = createReadStream(asset)
    stream.on("error", (error) => {
      console.error("Editspace renderer asset read failed", { code: "code" in error ? error.code : undefined, asset: url.pathname })
      if (!res.headersSent) finish(500, "Renderer unavailable")
      else res.destroy()
    })
    res.on("close", () => stream.destroy())
    stream.pipe(res)
  })
  const mux = eventMux({
    rejectUnknown: true,
    origin: () => origin,
    authorize: (req) =>
      allowed(req) && req.headers.origin === origin && req.method === "GET" &&
      !new URL(req.url ?? "/", origin).search,
    upstream: (prefix, requested) => {
      if (!eventPaths.includes(requested.pathname) || !apiAllowed("GET", requested.pathname))
        throw new Error("Event path not exposed")
      const target = targets[prefix === "/oc" ? "oc" : "es"]
      if (!target) throw new Error("Event service not configured")
      return {
        url: `${target}${requested.pathname.slice(prefix.length)}${requested.search}`,
        headers: prefix === "/oc" && options.opencodeAuth ? { authorization: options.opencodeAuth } : undefined,
      }
    },
  })
  server.on("upgrade", mux.upgrade)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, host, resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing listener address")
  const origin = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`
  return {
    origin,
    key,
    close: async () => {
      server.off("upgrade", mux.upgrade)
      mux.close()
      upstreams.forEach((upstream) => upstream.destroy())
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}

const voiceID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const voiceRoute = async (
  voice: Voice,
  req: IncomingMessage,
  pathname: string,
  origin: string,
  finish: (status: number, body: string, type?: string) => void,
) => {
  const json = (status: number, value: unknown) => finish(status, JSON.stringify(value), "application/json")
  if (pathname === "/__es/voice" && req.method === "GET") return json(200, await voice.status())
  const action = /^\/__es\/voice\/(start|stop|cancel|settings)$/.exec(pathname)?.[1]
  if (!action || req.method !== "POST") return finish(404, "Not found")
  if (req.headers.origin !== origin || !req.headers["content-type"]?.startsWith("application/json"))
    return finish(403, "Dictation requires the native origin")
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256) return finish(413, "Payload too large")
    chunks.push(chunk)
  }
  const body: unknown = (() => {
    try {
      return JSON.parse(Buffer.concat(chunks).toString())
    } catch {
      return undefined
    }
  })()
  if (action === "settings") return (await voice.settings()) ? json(200, { ok: true }) : finish(404, "Not found")
  const id = body && typeof body === "object" && "id" in body && typeof body.id === "string" ? body.id : ""
  if (!voiceID.test(id)) return json(400, { ok: false, code: "invalid", message: "Invalid dictation id" })
  if (action === "cancel") {
    await voice.cancel(id)
    return json(200, { ok: true })
  }
  const result = action === "start" ? await voice.start(id) : await voice.stop(id)
  const status = result.ok
    ? 200
    : ({ busy: 409, inactive: 409, cancelled: 409, unavailable: 503, permission: 403, empty: 422, failed: 500 } as const)[result.code]
  return json(status, result)
}
