import type { ProxyOptions } from "vite"
import { attentionRoute, remoteCookie, remoteSetCookie } from "./remote-host"

export const apiProxy = (target: string, prefix: string, remote?: { id: string; origin: string }): ProxyOptions => ({
  target,
  changeOrigin: true,
  rewrite: (path) => path.slice(prefix.length),
  configure(proxy) {
    if (remote)
      proxy.on("proxyReq", (request, incoming) => {
        // The remote gate authenticates the tailnet user: never forward this machine's credentials,
        // and present only that host's own operator cookie and public origin to its dashboard.
        // Vite has already stripped the prefix from incoming.url.
        const attention = attentionRoute.test(`${prefix}${(incoming.url ?? "").split("?")[0]}`)
        const cookie = attention ? remoteCookie(incoming.headers.cookie, remote.id) : undefined
        request.removeHeader("authorization")
        request.removeHeader("proxy-authorization")
        request.removeHeader("referer")
        if (cookie) request.setHeader("cookie", cookie)
        else request.removeHeader("cookie")
        if (attention) request.setHeader("origin", remote.origin)
        else request.removeHeader("origin")
      })
    proxy.on("proxyRes", (response, incoming) => {
      // API/SSE failures belong in the app, not the browser's HTTP login dialog.
      if (response.statusCode === 401) delete response.headers["www-authenticate"]
      if (!remote) return
      const cookies = attentionRoute.test(`${prefix}${(incoming.url ?? "").split("?")[0]}`) ? remoteSetCookie(response.headers["set-cookie"], remote.id) : undefined
      if (cookies) response.headers["set-cookie"] = cookies
      else delete response.headers["set-cookie"]
    })
  },
})
