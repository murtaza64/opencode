import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  server: {
    port: 3100,
    // spike: proxy the daemon so the browser stays same-origin (CORS check
    // against :4096 direct is a later step)
    proxy: {
      "/oc": {
        target: "http://127.0.0.1:4096",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/oc/, ""),
      },
      "/es": {
        target: "http://127.0.0.1:7777",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/es/, ""),
      },
    },
  },
  build: {
    target: "esnext",
  },
})
