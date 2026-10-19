import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { startPanelPreview } from "./composer-panel-preview.mjs"

export const longID = `ses_${"0123456789abcdef".repeat(24)}`
export const longName = `فريق-reviewer-${"long-lane-name-".repeat(32)}`
export const body = `First line: مرحباً from the reviewer\nhttps://example.com/${"unbroken".repeat(80)}\n\n\`\`\`ts\nconst receipt = "${longID}"\n\`\`\`\nFinal line: all content remains reachable.`

export const startMailOverflowPreview = async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "mail-overflow-"))
  const preview = await startPanelPreview([{
    name: "mail-overflow:isolated-deps",
    config: () => ({ cacheDir: path.join(scratch, "vite"), optimizeDeps: { include: ["@opencode-ai/ui > @shikijs/stream", "@opencode-ai/ui > remend"] } }),
  }])
  const ts = "2026-10-13T12:00:00Z"
  preview.fixture.mail = (es, lane) => ({ editspace: es, lane, messages: lane !== "lane-alpha" ? [] : [
    { id: "reference", ts, from: "reviewer", to: "lane-alpha", direction: "received", text: "Referenced mail", deliveries: [] },
    ...["received", "sent"].map(direction => ({
      id: `${direction}-${longID}`, ts, from: longName, to: `${longName}-recipient`, direction,
      kind: "task", text: body, sender_session: direction === "sent" ? "ses_a" : longID,
      origin_run: longID, relationship: `peer-${longName}`, in_reply_to: "reference", supersedes: longID,
      deliveries: Array.from({ length: 160 }, (_, i) => ({
        message_id: `${direction}-${longID}`, recipient: `${longName}-${i}`, session: i === 0 ? "ses_a" : longID,
        mode: "queue", state: i === 159 ? "handled" : "queued", request_id: `${longID}-${i}`,
        error: i === 159 ? `Delivery diagnostic: https://example.com/${longID}` : null,
        presented_at: ts, handled_at: i === 159 ? ts : null,
      })),
    })),
  ] })
  return {
    ...preview,
    url: `${preview.origin}/session/ses_a?directory=${encodeURIComponent(`${preview.fixture.editspaces[0].root}/lanes/lane-alpha/repos/org/repo`)}`,
    close: async () => { await preview.close(); await rm(scratch, { recursive: true, force: true }) },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startMailOverflowPreview()
  console.log(`PREVIEW ${preview.url}\nSTOP kill ${process.pid}\nAuto-stop after 30 minutes`)
  const close = () => void preview.close().then(() => process.exit(0))
  process.on("SIGINT", close)
  process.on("SIGTERM", close)
  setTimeout(close, 30 * 60 * 1000).unref()
}
