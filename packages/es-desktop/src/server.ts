import { createServer, request, type IncomingHttpHeaders } from "node:http"
import { createReadStream } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { apiAllowed, serviceURL } from "./policy"

const csp =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const offline = `<!doctype html><html lang="en" dir="ltr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Editspace unavailable</title><style>body{font:16px system-ui;background:#171819;color:#ececec;margin:0;padding:10vh 8vw}main{max-inline-size:42rem}h1{font-size:28px}p{line-height:1.6;color:#bbb}a{color:#9ac9ff}code{direction:ltr;unicode-bidi:isolate}</style><main><h1>Services unavailable</h1><p>Editspace attaches to existing services. It does not start or stop them.</p><p>Launch with explicit <code>OPENCODE_URL</code> and <code>ES_DASHBOARD_URL</code> loopback origins. For an isolated demo, run <code>bun run preview</code> from the es-desktop package.</p><p>Once the services are available, <a href="/">retry connection</a>.</p></main></html>`
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
}) => {
  const targets = { oc: serviceURL(options.opencode), es: serviceURL(options.dashboard) }
  const renderer = serviceURL(options.renderer)
  const root = await realpath(options.root)
  const key = randomBytes(32).toString("hex")
  const upstreams = new Set<ReturnType<typeof request>>()
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", csp)
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("Referrer-Policy", "no-referrer")
    res.setHeader("Cache-Control", "no-store")
    const finish = (status: number, body: string, type = "text/plain") => {
      res.writeHead(status, { "content-type": type })
      res.end(body)
    }
    if (
      req.headers.host !== new URL(origin).host ||
      req.headers["x-editspace-key"] !== key ||
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      finish(403, "Forbidden")
      return
    }
    const url = new URL(req.url ?? "/", origin)
    if (url.origin !== origin) return finish(403, "Forbidden")
    const api = /^\/(oc|es)(\/|$)/.exec(url.pathname)
    if (api && !apiAllowed(req.method ?? "", url.pathname)) return finish(403, "API route not exposed")
    const target = api ? targets[api[1] as keyof typeof targets] : renderer
    if (api && !target) return finish(503, '{"error":"Service not configured"}', "application/json")
    if (!api && !["GET", "HEAD"].includes(req.method ?? "")) return finish(405, "Method not allowed")
    if (!api && (req.headers["sec-fetch-dest"] === "document" || url.pathname === "/")) {
      const ready = await Promise.all(
        [targets.oc && `${targets.oc}/experimental/capabilities`, targets.es && `${targets.es}/api/editspaces`].map(
          (value, index) =>
            value
              ? fetch(value, {
                  signal: AbortSignal.timeout(2000),
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
      // Concatenate the path rather than resolving it: //host must never switch upstreams.
      const upstream = request(
        `${target}${api ? url.pathname.slice(api[1].length + 1) || "/" : url.pathname}${url.search}`,
        {
          method: req.method,
          headers: {
            ...proxyHeaders(req.headers),
            ...(api?.[1] === "oc" && options.opencodeAuth ? { authorization: options.opencodeAuth } : {}),
          },
        },
        (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
            response.resume()
            return finish(502, '{"error":"Upstream redirect blocked"}', "application/json")
          }
          res.writeHead(response.statusCode ?? 502, proxyHeaders(response.headers))
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
    const stream = createReadStream(asset)
    stream.on("error", () => {
      if (!res.headersSent) finish(500, "Renderer unavailable")
      else res.destroy()
    })
    res.on("close", () => stream.destroy())
    stream.pipe(res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing loopback address")
  const origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    key,
    close: async () => {
      upstreams.forEach((upstream) => upstream.destroy())
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}
