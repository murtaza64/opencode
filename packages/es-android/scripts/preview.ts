import { existsSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { createPairingCode } from "../../es-desktop/src/pairing"
import { startGateway } from "../src/gateway"
// @ts-expect-error untyped fixture module shared with es-app browser tests
import { createFixture, directory, session } from "../../es-app/test/composer-fixture.mjs"

// Fixture-only gateway: no model provider, daemon, or production service is contacted.
const args = parseArgs({ options: { port: { type: "string", default: "0" }, code: { type: "string" } } })
const root = path.resolve(import.meta.dir, "../dist/renderer")
if (!existsSync(path.join(root, "index.html"))) throw new Error("Run `bun run build:web` first")

const transcript = (sessionID: string) => [
  message(sessionID, "msg_a1", "user", "Check whether the Android client reconnects after the host restarts."),
  message(
    sessionID,
    "msg_a2",
    "assistant",
    "This is a fixture session served through the paired gateway. Sends here are echoed by the fixture; nothing runs on a real host.",
    "msg_a1",
  ),
]

const fixture = await createFixture()
fixture.status = "idle"
fixture.permissions = []
fixture.messages = transcript("ses_a")
fixture.mail = (_: string, lane: string) => ({ editspace: "fixture", lane, messages: [] })
// Workspace sessions carry the dashboard's `updated` field, so the sidebar groups them by day.
fixture.sessionIDs = []
fixture.workspaceSessions = [
  { ...session("ses_a"), time: { created: Date.now() - 60_000, updated: Date.now() - 30_000 } },
  { ...session("ses_b"), time: { created: Date.now() - 3_600_000, updated: Date.now() - 3_000_000 } },
]
fixture.messagesB = [message("ses_b", "msg_a1", "user", "Second fixture session.")]
// Echo admitted prompts so the transcript visibly advances in the preview.
const push = fixture.calls.push.bind(fixture.calls)
fixture.calls.push = (...calls: { method: string; path: string; body: { parts?: { type: string; text?: string }[] } }[]) => {
  calls
    .filter((call) => call.method === "POST" && /^\/session\/ses_a\/prompt_async$/.test(call.path))
    .forEach((call) => {
      const text = call.body.parts?.find((part) => part.type === "text")?.text ?? ""
      const stamp = Date.now()
      const user = message("ses_a", `msg_b${stamp}u`, "user", text)
      const reply = message("ses_a", `msg_b${stamp}v`, "assistant", `Fixture received: ${text}`, user.info.id)
      fixture.messages.push(user, reply)
      setTimeout(() => {
        for (const item of [user, reply]) {
          fixture.emit("message.updated", { sessionID: "ses_a", info: item.info })
          item.parts.forEach((part) => fixture.emit("message.part.updated", { sessionID: "ses_a", part }))
        }
      }, 300)
    })
  return push(...calls)
}

const code = args.values.code ?? createPairingCode()
const gateway = await startGateway({
  host: "127.0.0.1",
  port: Number(args.values.port),
  code,
  root,
  opencode: fixture.url,
  dashboard: fixture.url,
})
console.info(`Preview ${gateway.origin}`)
console.info(`Pairing code ${code}`)
console.info(`Fixture ${fixture.url} (PID ${process.pid}); stop with kill ${process.pid}`)
const stop = () =>
  void Promise.all([gateway.close(), fixture.close()]).finally(() => process.exit(0))
process.on("SIGINT", stop)
process.on("SIGTERM", stop)

function message(sessionID: string, id: string, role: "user" | "assistant", text: string, parentID?: string) {
  const time = { created: Date.now(), ...(role === "assistant" ? { completed: Date.now() } : {}) }
  return {
    info:
      role === "user"
        ? { id, sessionID, role, agent: "build", model: { providerID: "fixture", modelID: "test" }, time }
        : {
            id,
            parentID,
            sessionID,
            role,
            agent: "build",
            mode: "build",
            providerID: "fixture",
            modelID: "test",
            path: { cwd: directory, root: directory },
            time,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
    parts: [{ id: `part_${id}`, messageID: id, sessionID, type: "text", text }],
  }
}
