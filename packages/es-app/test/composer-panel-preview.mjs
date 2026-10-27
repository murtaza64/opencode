import { createServer } from "vite"
import net from "node:net"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createFixture, directory } from "./composer-fixture.mjs"

// `opencode` points /oc requests and event streams at another (private) runtime.
/** Warm Vite's transform cache once with a throwaway page and a generous allowance: the dev
 * server transforms ~2k modules on first load, which exceeded tests' 30 s first navigation on a
 * loaded host. ES_APP_PREVIEW_WARM=0 skips it. The warmup's fixture calls are cleared. */
export const warmVite = async (origin, fixture, path = `/session/ses_a?directory=${encodeURIComponent(directory)}`) => {
  if (process.env.ES_APP_PREVIEW_WARM === "0") return
  const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
  const browser = await chromium.launch({ channel: "chrome", headless: true })
  try {
    const page = await browser.newPage()
    await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    await page.goto(`${origin}${path}`, { timeout: 600_000 }).catch(() => {})
  } finally {
    await browser.close()
  }
  if (fixture) {
    fixture.calls.length = 0
    fixture.unexpected.length = 0
  }
}

export const startPanelPreview = async (plugins = [], portHint = 0, options = {}) => {
  const fixture = await createFixture()
  // A shared dependency cache: a fresh one per run made Vite re-scan and re-bundle every
  // dependency (minutes on a loaded host), so the first page.goto of most browser tests timed out.
  // ES_APP_PREVIEW_FRESH_CACHE=1 restores an isolated cache for a run that needs it.
  const fresh = process.env.ES_APP_PREVIEW_FRESH_CACHE === "1"
  const cache = fresh ? await mkdtemp(path.join(tmpdir(), "es-app-preview-vite-")) : fileURLToPath(new URL("../node_modules/.vite-es-app-preview", import.meta.url))
  fixture.permissions = []
  fixture.messages = [
    {
      info: {
        id: "msg_1",
        sessionID: "ses_a",
        role: "user",
        agent: "build",
        model: { providerID: "fixture", modelID: "test" },
        time: { created: 1 },
      },
      parts: [
        {
          id: "part_1",
          messageID: "msg_1",
          sessionID: "ses_a",
          type: "text",
          text: "Review the composer and its session controls.",
        },
      ],
    },
    {
      info: {
        id: "msg_2",
        parentID: "msg_1",
        sessionID: "ses_a",
        role: "assistant",
        agent: "build",
        mode: "build",
        providerID: "fixture",
        modelID: "test",
        path: { cwd: directory, root: directory },
        time: { created: 2 },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: "part_2",
          messageID: "msg_2",
          sessionID: "ses_a",
          type: "text",
          text: "This is an isolated UI preview. Session actions affect only disposable fixture state.\n\nThe task is paused. Try **Aside**, **Queue**, or **Steer** below. Queue and Steer remain text-only; attached images stay saved in the draft.",
        },
      ],
    },
  ]
  process.env.OPENCODE_URL = options.opencode ?? fixture.url
  process.env.ES_DASHBOARD_URL = fixture.url
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(portHint, "127.0.0.1", resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    cacheDir: cache,
    optimizeDeps: { include: ["@opencode-ai/session-ui > @shikijs/stream", "@opencode-ai/session-ui > remend", "@opencode-ai/ui > @shikijs/stream", "@opencode-ai/ui > remend"] },
    plugins,
    server: { host: "127.0.0.1", port, strictPort: true },
  })
  await vite.listen()
  const origin = `http://127.0.0.1:${port}`
  await warmVite(origin, fixture)
  return {
    fixture,
    origin,
    url: `${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`,
    close: async () => { await Promise.all([vite.close(), fixture.close()]); await (fresh ? rm(cache, { recursive: true, force: true }) : undefined) },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startPanelPreview()
  console.log(`PREVIEW ${preview.url}\nFIXTURE ${preview.fixture.url}\nSTOP kill ${process.pid}`)
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await preview.close()
    process.exit(0)
  }
  process.on("SIGINT", close)
  process.on("SIGTERM", close)
}
