import { startPanelPreview } from "./composer-panel-preview.mjs"

const preview = await startPanelPreview()
preview.fixture.status = "idle"
preview.fixture.laneOwners = [{ lane: "work", owner: "ses_a" }]
preview.fixture.pendingHandoffs = [{
  lane: "work", predecessor: "ses_a", successor: "ses_b", request_id: "preview-rollover",
  status: "prepared", error: null, reason: "Context rollover at 500k tokens",
}]
preview.fixture.superseded.set("ses_a", { successor: "ses_b" })
console.log(`PREVIEW ${preview.url}\nSTOP kill ${process.pid}`)
const close = async () => {
  await preview.close()
  process.exit(0)
}
process.on("SIGINT", close)
process.on("SIGTERM", close)
