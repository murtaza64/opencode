import type { ProxyOptions } from "vite"

export const apiProxy = (target: string, prefix: string): ProxyOptions => ({
  target,
  changeOrigin: true,
  rewrite: (path) => path.slice(prefix.length),
  configure(proxy) {
    proxy.on("proxyRes", (response) => {
      // API/SSE failures belong in the app, not the browser's HTTP login dialog.
      if (response.statusCode === 401) delete response.headers["www-authenticate"]
    })
  },
})
