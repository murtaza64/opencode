import { createServer } from "vite"
import net from "node:net"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createFixture, directory } from "./composer-fixture.mjs"

export const startPanelPreview = async () => {
  const fixture = await createFixture()
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
  process.env.OPENCODE_URL = fixture.url
  process.env.ES_DASHBOARD_URL = fixture.url
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { host: "127.0.0.1", port, strictPort: true },
  })
  await vite.listen()
  const origin = `http://127.0.0.1:${port}`
  return {
    fixture,
    origin,
    url: `${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`,
    close: () => Promise.all([vite.close(), fixture.close()]),
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
