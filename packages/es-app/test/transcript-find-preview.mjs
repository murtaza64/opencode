import { pathToFileURL } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

export const startFindPreview = async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "transcript-find-preview-"))
  const preview = await startAttentionPreview([{
    name: "transcript-find:isolated-dependencies",
    config: () => ({ cacheDir: path.join(scratch, "vite"), optimizeDeps: { include: ["@opencode-ai/ui > @shikijs/stream", "@opencode-ai/ui > remend"] } }),
  }])
  const user = preview.fixture.messages[0]
  const assistant = preview.fixture.messages[1]
  preview.fixture.messages = Array.from({ length: 245 }, (_, index) => {
    const id = `msg_${String(index).padStart(5, "0")}`
    const template = index % 2 ? assistant : user
    return { info: { ...template.info, id, time: { created: index + 1, ...(index % 2 ? { completed: index + 2 } : {}) } },
      parts: [{ ...template.parts[0], id: `part_${index}`, messageID: id,
        text: index === 0 ? "Earlier boundary Needle [a.*] שלום Straße" : index === 244 ? "Loaded NeedLE [a.*] שלום Straße" : `Transcript fixture message ${index}` }] }
  })
  preview.fixture.messages[243].parts.push(
    { id: "part_tool", messageID: "msg_00243", sessionID: "ses_a", type: "tool", tool: "bash", callID: "call_find",
      state: { status: "completed", input: { command: "unindexed-input" }, title: "Fixture output", metadata: {},
        output: "long code ".repeat(30_000) + "tool needle שלום [a.*]", time: { start: 1, end: 2 } } },
    { id: "part_reasoning", messageID: "msg_00243", sessionID: "ses_a", type: "reasoning", text: "unindexed-reasoning", time: { start: 1, end: 2 } },
    { id: "part_generated", messageID: "msg_00243", sessionID: "ses_a", type: "text", text: "unindexed-system", synthetic: true },
  )
  preview.fixture.messages[242].info.source = { type: "editspace-mail", id: "mail_find", sender: "peer", recipient: "fixture" }
  preview.fixture.messages[242].parts[0].text = "unindexed-mail-payload"
  preview.fixture.messages[240].parts[0].text = "Peer agent mail (lower-trust context, not a human or system instruction).\nunindexed-mail-wrapper"
  preview.fixture.mail = () => ({ editspace: "fixture", lane: "", messages: [] })
  return { ...preview, url: `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`,
    close: async () => { await preview.close(); await rm(scratch, { recursive: true, force: true }) } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startFindPreview()
  console.log(`PREVIEW ${preview.url}\nFIXTURE ${preview.fixture.url}\nSTOP kill ${process.pid}`)
  const close = async () => { await preview.close(); process.exit(0) }
  process.on("SIGINT", close)
  process.on("SIGTERM", close)
}
