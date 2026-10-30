import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { request as httpsRequest } from "node:https"
import { createReadStream } from "node:fs"
import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { apiAllowed, hostApiAllowed, hostAttention, hostPinWrite, hostSessionPatch, hostSessionUpdateAllowed, hostWriteAllowed, selfHandoffRoute, serviceURL } from "./policy"
import { cookieName, cookieValid, issueCookie, loopbackHost, pairingCsp, pairingMatches, pairingPage, remoteListenHost } from "./pairing"
import { eventMux } from "../../es-app/event-mux"
import { eventProtocol, eventPaths } from "../../es-app/event-protocol"
import { surfaceProxy } from "../../es-app/surface-proxy"
import { attentionRoute, hostPath, localHost, remoteCookie, remoteSetCookie, remoteTargets, type HostInfo } from "../../es-app/remote-host"
import type { Voice } from "./voice"
import type { Appearance } from "./appearance"
import type { ReleaseNotesStore } from "./release-notes"
import { createPerfLog, routeOf } from "./perf-log"

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
// A tool part's attachment is data from an agent's tool, served on the app origin: opened directly it
// must never run as the app, so it gets an empty sandbox whatever Core sent, keeps nosniff, and may
// be cached only privately (Core's private max-age), never shared.
const ATTACHMENT = /^\/oc\/session\/[\w-]+\/message\/[\w-]+\/part\/[\w-]+\/attachment\/\d{1,4}$/
const attachmentHeaders = (headers: IncomingHttpHeaders) => {
  const cache = headers["cache-control"]
  return {
    "content-security-policy": "sandbox; default-src 'none'",
    "x-content-type-options": "nosniff",
    "cache-control": typeof cache === "string" && /^private(?:,\s*max-age=\d{1,7})?$/.test(cache.trim()) ? cache.trim() : "no-store",
  }
}

const SECRET_INTAKE = /^\/es\/api\/secret-intake\/[\w-]+$/

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
  // `code` as a function is read per check, so a rotated code takes effect without a restart.
  pairing?: { code: string | (() => string); codeFile?: string; sshHost?: string; maxAgeSeconds?: number }
  // Paired gateway behind an HTTPS identity proxy (Tailscale Serve): the exact client-facing
  // origin, also accepted for Origin and Host checks. The proxy must be the only route in.
  publicOrigin?: string
  // Native-only operator dictation; paired remote clients never reach this host's microphone.
  voice?: Voice
  // This laptop's palette and blurred wallpaper; never offered to paired remote clients.
  appearance?: Appearance
  // This app release's notes and whether they were seen; one store for every listener of this app, never offered to
  // paired remote clients.
  releaseNotes?: ReleaseNotesStore
  // A remote execution host (validated tailnet origin) in place of the loopback services.
  remote?: { id: string; origin: string }
  // Local performance journal directory (renderer reports + slow proxied requests); off when unset.
  perfDir?: string
  // The hosts this listener reports to the app, read per request once every listener is up.
  hostInfo?: () => HostInfo
  // Work view hosts this (local) listener reads at /hosts/<id>/...: list reads and their event
  // streams only, with no credential or cookie. Their app pages stay on their own listeners.
  peers?: { id: string; origin: string }[]
}) => {
  const host = options.host ? remoteListenHost(options.host) : "127.0.0.1"
  if (!host) throw new Error("Remote listeners must bind loopback or a tailnet address")
  if (!loopbackHost(host) && !options.pairing) throw new Error("Non-loopback listeners require pairing")
  const pairing = options.pairing
  const pairingCode = () => (typeof pairing?.code === "function" ? pairing.code() : pairing?.code ?? "")
  const publicOrigin = options.publicOrigin ? httpsOrigin(options.publicOrigin) : undefined
  if (publicOrigin && !pairing) throw new Error("A public origin requires pairing")
  const failures = { count: 0, since: 0 }
  const remote = options.remote
  const peers = new Map((remote || pairing ? [] : options.peers ?? []).map((peer) => [peer.id, remoteTargets(peer.origin)]))
  // Voice may join a remote listener: capture and transcription stay on this machine and the
  // text only reaches that tab's draft, never the remote host.
  if (remote && (options.opencode || options.dashboard || options.opencodeAuth))
    throw new Error("A remote host listener attaches to that host only")
  const targets = remote
    ? { oc: remoteTargets(remote.origin).opencode, es: remoteTargets(remote.origin).dashboard }
    : { oc: serviceURL(options.opencode), es: serviceURL(options.dashboard) }
  const renderer = serviceURL(options.renderer)
  const root = await realpath(options.root)
  const index = renderer ? undefined : await readFile(path.join(root, "index.html"))
  const key = randomBytes(32).toString("hex")
  const upstreams = new Set<ReturnType<typeof httpRequest>>()
  // Surface upstreams are loopback addresses on the dashboard's machine; never resolve a remote host's here. A remote
  // host's listener serves that host's file surfaces through its dashboard (same identity gate as its /es reads).
  const surfaces = surfaceProxy({ dashboard: remote ? undefined : targets.es, remote: remote ? targets.es : undefined, publicOrigin })
  // A Work host's file surfaces framed in this window: minted at /hosts/<id>/__es/surface/<sid>, served from that host's
  // dashboard under /__cap/host/<id>/surface/, each host signing its own capabilities. URL surfaces stay own-host only.
  const peerSurfaces = new Map([...peers].map(([id, peer]) => [id, surfaceProxy({ dashboard: undefined, remote: peer.dashboard, base: `/__cap/host/${id}/surface`, publicOrigin })]))
  // Paired remote clients never write this machine's performance journal.
  const perf = pairing || !options.perfDir ? undefined : createPerfLog({ dir: options.perfDir, host: remote?.id ?? "local" })
  const sameHost = (req: { headers: IncomingHttpHeaders }) =>
    req.headers.host === new URL(origin).host || (!!publicOrigin && req.headers.host === new URL(publicOrigin).host)
  const trusted = (value: string | undefined) => value === origin || (!!publicOrigin && value === publicOrigin)
  const allowed = (req: { headers: IncomingHttpHeaders; method?: string }) =>
    sameHost(req) &&
    (pairing
      ? cookieValid(pairingCode(), req.headers) &&
        // SameSite ignores ports, so other local origins also carry the cookie:
        // require same-origin fetch metadata, and the page origin for writes.
        [undefined, "same-origin", "none"].includes(req.headers["sec-fetch-site"] as string | undefined) &&
        (["GET", "HEAD"].includes(req.method ?? "") || trusted(req.headers.origin))
      : req.headers["x-editspace-key"] === key) &&
    (!req.headers.origin || trusted(req.headers.origin)) &&
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
      finish(status, pairingPage(error, pairing.codeFile, process.platform, pairing.sshHost), "text/html; charset=utf-8")
    }
    if (url.pathname !== "/__es/pair" || req.method !== "POST") {
      if (req.method === "GET" && (req.headers["sec-fetch-dest"] === "document" || req.headers.accept?.includes("text/html")))
        return page(401)
      return finish(401, JSON.stringify({ error: "Pairing required" }), "application/json")
    }
    if (req.headers["sec-fetch-site"] === "cross-site" || !(req.headers.origin === undefined || req.headers.origin === "null" || trusted(req.headers.origin)))
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
    if (!pairingMatches(pairingCode(), code)) {
      failures.count++
      return page(401, "That code does not match. Check it again on the host and try once more.")
    }
    res.writeHead(303, {
      location: "/",
      "set-cookie": `${cookieName}=${issueCookie(pairingCode())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${pairing.maxAgeSeconds ?? 30 * 86400}${publicOrigin ? "; Secure" : ""}`,
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
    // Capability-addressed content (surface frames): opaque-origin sandboxes without the app's
    // cookie or key, and outside the edge's sign-in. The path's capability is the only credential;
    // anything under /__cap/ that is not a valid surface capability gets a plain 404.
    if (sameHost(req) && req.url?.startsWith("/__cap/")) {
      res.removeHeader("Content-Security-Policy")
      const peer = /^\/__cap\/host\/([a-z][a-z0-9-]{0,31})\//.exec(req.url)
      if (peer) {
        const proxy = peerSurfaces.get(peer[1]!)
        return proxy ? void proxy.serve(req, res) : finish(404, "Not found")
      }
      if (!targets.es) return finish(503, "Service not configured")
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
    if (url.pathname === "/__es/appearance/applied") {
      // The page's acknowledgement of what it applied: this app's own pages only (key + native origin).
      if (!options.appearance || pairing || req.method !== "POST" || url.search) return finish(404, "Not found")
      if (!trusted(req.headers.origin)) return finish(403, "Forbidden")
      return appliedRoute(options.appearance, req, remote?.id ?? "local", finish)
    }
    if (url.pathname === "/__es/release-notes") {
      if (!options.releaseNotes || pairing || req.method !== "GET" || url.search) return finish(404, "Not found")
      return finish(200, JSON.stringify(options.releaseNotes.read()), "application/json")
    }
    if (url.pathname === "/__es/release-notes/seen") {
      // The operator closed this release's notes: this app's own pages only (key + native origin).
      if (!options.releaseNotes || pairing || req.method !== "POST" || url.search) return finish(404, "Not found")
      if (!trusted(req.headers.origin)) return finish(403, "Forbidden")
      return seenRoute(options.releaseNotes, req, finish)
    }
    if (/^\/__es\/appearance(\/|$)/.test(url.pathname)) {
      if (!options.appearance || pairing || req.method !== "GET") return finish(404, "Not found")
      return appearanceRoute(options.appearance, req, res, url, finish)
    }
    if (url.pathname === "/__es/host") {
      if (req.method !== "GET" || url.search) return finish(403, "Forbidden")
      return finish(200, JSON.stringify(options.hostInfo?.() ?? localHost), "application/json")
    }
    if (url.pathname.startsWith("/__es/surface/")) {
      return surfaces.address(req, res)
    }
    if (url.pathname === "/__es/perf") {
      if (!perf || url.search) return finish(404, "Not found")
      return perf.receive(req, finish)
    }
    if (/^\/__es\/voice(\/|$)/.test(url.pathname)) {
      if (!options.voice || pairing || url.search) return finish(404, "Not found")
      return voiceRoute(options.voice, req, url.pathname, origin, finish)
    }
    const peerSurface = /^\/hosts\/([a-z][a-z0-9-]{0,31})\/__es\/surface\/[^/]+$/.exec(url.pathname)
    if (peerSurface) {
      const proxy = peerSurfaces.get(peerSurface[1]!)
      return proxy ? proxy.address(req, res) : finish(404, "Not found")
    }
    if (url.pathname.startsWith("/hosts/")) {
      const qualified = hostPath(url.pathname)
      const peer = qualified && peers.get(qualified.host)
      if (!qualified || !peer) return finish(404, "Not found")
      const upstream = `${qualified.path.startsWith("/oc") ? peer.opencode : peer.dashboard}${qualified.path.slice(3) || "/"}${url.search}`
      const write = hostWriteAllowed(req.method ?? "", qualified.path)
      if (!write && !hostApiAllowed(req.method ?? "", qualified.path)) return finish(403, "Host route not exposed")
      // A write to another host: only from this window (native origin), only the exact write routes.
      if (write && !trusted(req.headers.origin)) return finish(403, "Host writes require the native origin")
      // That host's attention routes carry only that host's operator cookie (minted by its own dashboard,
      // renamed per host and scoped to /hosts/<id>/ here); nothing else of this machine's goes upstream.
      if (hostAttention(qualified.path) || hostPinWrite(req.method ?? "", qualified.path))
        return peerWrite(req, res, upstream, new URL(peer.dashboard).origin, finish, {
          cookie: remoteCookie(req.headers.cookie, qualified.host),
          setCookie: (values) => remoteSetCookie(values, qualified.host)?.map((value) => scopeCookie(value, qualified.host)),
        })
      if (write && req.method === "PATCH" && hostSessionPatch.test(qualified.path)) {
        const body = await readLimited(req, 16_384)
        const parsed = body && (() => { try { return JSON.parse(body.toString("utf8")) as unknown } catch { return undefined } })()
        if (!hostSessionUpdateAllowed(parsed)) return finish(403, "Host session update not exposed")
        return peerWrite(req, res, upstream, new URL(peer.opencode).origin, finish, undefined, body!)
      }
      if (write) return peerWrite(req, res, upstream, new URL(peer.opencode).origin, finish)
      return peerRead(req, res, upstream, finish)
    }
    const api = /^\/(oc|es)(\/|$)/.exec(url.pathname)
    if (api && !apiAllowed(req.method ?? "", url.pathname)) return finish(403, "API route not exposed")
    // A secure decision field (dotfiles docs/es-secret-intake.md) is answered only on the computer that asked:
    // the native Local listener forwards it like an attention write; a remote host's listener or a
    // paired-device listener never does.
    const secret = SECRET_INTAKE.test(url.pathname)
    if (secret && (remote || pairing)) return finish(403, "Secure fields are answered on the computer that asked")
    const attention = attentionRoute.test(url.pathname) || selfHandoffRoute.test(url.pathname) || secret
    const attachment = api?.[1] === "oc" && ATTACHMENT.test(url.pathname)
    if (attention && req.method !== "GET" && !trusted(req.headers.origin))
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
      // With Work view hosts the app still loads: it shows Local as unavailable beside the others.
      if (ready.some((value) => !value) && !peers.size)
        return finish(503, remote ? remoteOffline(options.hostInfo?.()) : offline, "text/html; charset=utf-8")
    }
    if (target) {
      const operatorCookie = !attention
        ? undefined
        : remote
          ? remoteCookie(req.headers.cookie, remote.id)
          : req.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("es_attention_operator="))
      // Only the operator cookie returns to the browser, renamed per remote host.
      const setCookie = (values: string[] | undefined) => {
        if (!attention) return undefined
        if (remote) return remoteSetCookie(values, remote.id)
        const kept = values?.filter(value => value.startsWith("es_attention_operator="))
        return kept?.length ? kept : undefined
      }
      // A secure field's handle stays out of the performance journal.
      const timing = api ? perf?.proxy(req, res, secret ? "es/api/secret-intake/:handle" : `${api[1]}${routeOf(url.pathname.slice(api[1].length + 1))}`) : undefined
      if (timing) res.on("close", () => timing.done())
      // Concatenate the path rather than resolving it: //host must never switch upstreams.
      const upstream = (target.startsWith("https:") ? httpsRequest : httpRequest)(
        `${target}${api ? url.pathname.slice(api[1].length + 1) || "/" : url.pathname}${url.search}`,
        {
          method: req.method,
          headers: {
            ...proxyHeaders(req.headers),
            // The keyed listener has authenticated the dynamic native origin above.
            // Bind it to the configured dashboard origin; never wildcard local ports.
            ...(attention ? {
              origin: new URL(target).origin,
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
          timing?.headers(response.statusCode)
          if (timing) response.on("data", (chunk: Buffer) => timing.data(chunk.length))
          const cookies = setCookie(response.headers["set-cookie"])
          res.writeHead(response.statusCode ?? 502, { ...proxyHeaders(response.headers), ...(cookies ? { "set-cookie": cookies } : {}), ...(attachment ? attachmentHeaders(response.headers) : {}) })
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
      allowed(req) && trusted(req.headers.origin) && req.method === "GET" &&
      !new URL(req.url ?? "/", origin).search,
    upstream: (prefix, requested) => {
      if (!eventPaths.includes(requested.pathname) || !apiAllowed("GET", requested.pathname))
        throw new Error("Event path not exposed")
      const target = targets[prefix === "/oc" ? "oc" : "es"]
      if (!target) throw new Error("Event service not configured")
      const url = `${target}${requested.pathname.slice(prefix.length)}${requested.search}`
      // A remote dashboard trusts only its own public origin.
      if (remote) return { url, headers: { origin: remote.origin } as HeadersInit }
      return { url, headers: prefix === "/oc" && options.opencodeAuth ? { authorization: options.opencodeAuth } : undefined }
    },
    // Session events only: a Work view host's list follows its Core's global stream.
    hostUpstream: (id, prefix, requested) => {
      const peer = peers.get(id)
      if (!peer || requested.pathname !== "/oc/global/event") throw new Error("Host stream not exposed")
      return { url: `${peer.opencode}${requested.pathname.slice(prefix.length)}${requested.search}`, headers: { origin: new URL(peer.opencode).origin } }
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

// One read of a Work view host: no browser credential, no redirect, bounded time.
const peerRead = (req: IncomingMessage, res: ServerResponse, target: string, finish: (status: number, body: string, type?: string) => void) => {
  const upstream = (target.startsWith("https:") ? httpsRequest : httpRequest)(target, { method: req.method, headers: proxyHeaders(req.headers) }, (response) => {
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      response.resume()
      return finish(502, '{"error":"Upstream redirect blocked"}', "application/json")
    }
    res.writeHead(response.statusCode ?? 502, proxyHeaders(response.headers))
    response.on("error", () => res.destroy())
    response.pipe(res)
  })
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("Upstream idle timeout")))
  upstream.on("error", () => {
    if (res.headersSent) return res.destroy()
    finish(502, '{"error":"Host unavailable"}', "application/json")
  })
  res.on("close", () => upstream.destroy())
  upstream.end()
}

// An operator cookie for another host is sent only on that host's /hosts/<id>/ paths of this listener.
const scopeCookie = (value: string, host: string) => `${value.replace(/;\s*Path=[^;]*/i, "")}; Path=/hosts/${host}/`

const peerWrite = (
  req: IncomingMessage, res: ServerResponse, target: string, origin: string, finish: (status: number, body: string, type?: string) => void,
  attention?: { cookie?: string; setCookie: (values: string[] | undefined) => string[] | undefined },
  body?: Buffer,
) => {
  const upstream = (target.startsWith("https:") ? httpsRequest : httpRequest)(target, { method: req.method, headers: { ...proxyHeaders(req.headers), origin, ...(attention?.cookie ? { cookie: attention.cookie } : {}) } }, (response) => {
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      response.resume()
      return finish(502, '{"error":"Upstream redirect blocked"}', "application/json")
    }
    const cookies = attention?.setCookie(response.headers["set-cookie"])
    res.writeHead(response.statusCode ?? 502, { ...proxyHeaders(response.headers), ...(cookies ? { "set-cookie": cookies } : {}) })
    response.on("error", () => res.destroy())
    response.pipe(res)
  })
  upstream.setTimeout(60_000, () => upstream.destroy(new Error("Upstream idle timeout")))
  // The outcome of a write that fails in flight is unknown: the client checks by its message ID.
  upstream.on("error", () => {
    if (res.headersSent) return res.destroy()
    finish(502, '{"error":"Host unavailable"}', "application/json")
  })
  res.on("close", () => upstream.destroy())
  if (body) return upstream.end(body)
  req.pipe(upstream)
}

// A request body read whole for inspection; undefined when it exceeds `limit` bytes or the read fails.
const readLimited = (req: IncomingMessage, limit: number) => new Promise<Buffer | undefined>((resolve) => {
  const chunks: Buffer[] = []
  let size = 0
  req.on("data", (chunk: Buffer) => {
    size += chunk.length
    if (size <= limit) chunks.push(chunk)
  })
  req.on("end", () => resolve(size <= limit ? Buffer.concat(chunks) : undefined))
  req.on("error", () => resolve(undefined))
})

const voiceID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const voiceRoute = async (
  voice: Voice,
  req: IncomingMessage,
  pathname: string,
  origin: string,
  finish: (status: number, body: string, type?: string) => void,
) => {
  const json = (status: number, value: unknown) => finish(status, JSON.stringify(value), "application/json")
  // Listener origins identify host tabs sharing this process's one microphone.
  if (pathname === "/__es/voice" && req.method === "GET") return json(200, await voice.status(origin))
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
  const result = action === "start" ? await voice.start(id, origin) : await voice.stop(id)
  const status = result.ok
    ? 200
    : ({ busy: 409, inactive: 409, cancelled: 409, unavailable: 503, permission: 403, empty: 422, failed: 500 } as const)[result.code]
  return json(status, result)
}

const httpsOrigin = (value: string) => {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Public origin must be an explicit https://host[:port] origin")
  return url.origin
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const remoteOffline = (host: HostInfo | undefined) => {
  const local = host?.hosts.find((item) => item.id === "local")
  return `<!doctype html><html lang="en" dir="ltr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="5"><title>${escape(host?.label ?? "Remote host")} unavailable</title><style>body{font:16px system-ui;background:#171819;color:#ececec;margin:0;padding:10vh 8vw}main{max-inline-size:42rem}h1{font-size:28px}p{line-height:1.6;color:#bbb}a{color:#9ac9ff}</style><main><h1>${escape(host?.label ?? "Remote host")} unavailable</h1><p>Its OpenCode or dashboard did not answer through the tailnet gate. Nothing on this machine changed.</p><p>Retrying every 5 seconds. <a href="/">Retry now</a>${local ? ` or <a href="${escape(local.origin)}/">return to ${escape(local.label)}</a>` : ""}.</p></main></html>`
}

const seenRoute = async (notes: ReleaseNotesStore, req: IncomingMessage, finish: (status: number, body: string, type?: string) => void) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk)
    if (chunks.reduce((sum, item) => sum + item.length, 0) > 512) return finish(413, "Payload too large")
  }
  const release = (() => {
    try {
      const value = (JSON.parse(Buffer.concat(chunks).toString()) as { release?: unknown } | null)?.release
      return typeof value === "string" ? value : undefined
    } catch {
      return undefined
    }
  })()
  if (!release) return finish(400, "Invalid release")
  // Another release (a page loaded before an update) is refused, never recorded.
  return (await notes.markSeen(release)) ? finish(204, "") : finish(409, "Not this release")
}

const appliedRoute = async (appearance: Appearance, req: IncomingMessage, host: string, finish: (status: number, body: string, type?: string) => void) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk)
    if (chunks.reduce((sum, item) => sum + item.length, 0) > 512) return finish(413, "Payload too large")
  }
  const body = (() => {
    try {
      return JSON.parse(Buffer.concat(chunks).toString()) as unknown
    } catch {
      return undefined
    }
  })()
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const revision = record.walRevision === null ? null : typeof record.walRevision === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(record.walRevision) ? record.walRevision : undefined
  if (revision === undefined || (record.theme !== "wallpaper" && record.theme !== "default")) return finish(400, "Invalid acknowledgement")
  await appearance.applied(host, { walRevision: revision, theme: record.theme })
  return finish(204, "")
}

const appearanceRoute = (
  appearance: Appearance,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  finish: (status: number, body: string, type?: string) => void,
) => {
  if (url.pathname === "/__es/appearance") {
    const body = appearance.body()
    if (!body || url.search) return finish(404, "Not found")
    return finish(200, JSON.stringify(body), "application/json")
  }
  if (url.pathname === "/__es/appearance/wallpaper") {
    const image = appearance.image()
    const version = new URLSearchParams(url.search).get("v")
    if (!image || !version || appearance.body()?.wallpaper !== `/__es/appearance/wallpaper?v=${encodeURIComponent(version)}`)
      return finish(404, "Not found")
    // Versioned by content: the URL changes whenever the wallpaper does.
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" })
    return res.end(image)
  }
  if (url.pathname === "/__es/appearance/events" && !url.search) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" })
    res.write(": ready\n\n")
    const stop = appearance.subscribe(() => res.write("data: changed\n\n"))
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000)
    req.on("close", () => {
      stop()
      clearInterval(ping)
    })
    return
  }
  finish(404, "Not found")
}
