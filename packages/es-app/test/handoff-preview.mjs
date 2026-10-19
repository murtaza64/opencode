import { pathToFileURL } from "node:url"
import { startPanelPreview } from "./composer-panel-preview.mjs"

export const startHandoffPreview = async () => {
  const preview = await startPanelPreview()
  preview.fixture.status = "idle"
  preview.fixture.mail = () => ({ editspace: "fixture", lane: "work", messages: [] })
  preview.fixture.images = (await import("./composer-fixture.mjs")).imageCapability
  preview.fixture.handoffs = [{ lane: "work", predecessor: "ses_a", successor: "ses_b" }]
  preview.fixture.laneOwners = [{ lane: "work", owner: "ses_b" }]
  preview.fixture.superseded.set("ses_a", { successor: "ses_b" })
  preview.fixture.messages[1].parts[0].text = "Disposable handoff demo. Send a draft here to see the superseded error in the transcript, then move it to the successor without sending. To check overwrite confirmation, first save a draft in Other session and return here."
  return preview
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startHandoffPreview()
  console.log(`PREVIEW ${preview.url}\nFIXTURE ${preview.fixture.url}\nSTOP kill ${process.pid}`)
  const close = async () => { await preview.close(); process.exit(0) }
  process.on("SIGINT", close)
  process.on("SIGTERM", close)
}
