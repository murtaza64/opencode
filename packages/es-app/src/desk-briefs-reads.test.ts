import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import { createBriefs, type DeskPointer } from "./desk-session"

// The Front Desk polls every project's brief anchor. Each read is a browser socket held for as long as
// Core takes to answer; on a stalled Core, a burst of 2 × anchors reads filled the six-socket pool and
// queued unrelated reads (attention, mail) for seconds. These tests pin the read budget per poll.
const anchors = (count: number): DeskPointer[] => Array.from({ length: count }, (_, index) => ({ session: `ses_fdbrief_${index}`, directory: `/es/${index}` }))
const brief = (id: string, directory: string): Session => ({
  id, directory, parentID: "ses_fdbrief_0", projectID: "p", title: id, version: "1", time: { created: 1, updated: 1 },
  metadata: { frontDesk: { kind: "brief", requestID: id, source: "attention:es:r1", revision: "1", title: "t", refs: [] } },
} as unknown as Session)

const start = (children: (id: string) => Session[] = () => []) => {
  const calls: string[] = []
  let open = 0
  let peak = 0
  const held = async <T,>(name: string, value: T) => {
    calls.push(name)
    peak = Math.max(peak, ++open)
    await Bun.sleep(5)
    open--
    return value
  }
  const client = {
    children: (id: string) => held(`children ${id}`, children(id)),
    status: (directory: string) => held(`status ${directory}`, {}),
    messagesTail: (id: string) => held(`tail ${id}`, []),
  }
  const [target, ...others] = anchors(11)
  const briefs = createRoot(() => createBriefs(() => target, () => undefined, undefined, () => others, { client, readOnly: true }))
  return { briefs, calls, peak: () => peak }
}

test("one poll reads each anchor's children once, without status for anchors that hold no briefs", async () => {
  const { calls, peak } = start()
  // The mount read is the first poll.
  await Bun.sleep(50)
  expect(calls.filter(call => call.startsWith("children")).length).toBe(11)
  expect(calls.filter(call => call.startsWith("status")).length).toBe(0)
  expect(peak()).toBeLessThanOrEqual(4)
})

test("other projects' anchors are not re-read on every fast poll", async () => {
  const { briefs, calls } = start()
  await Bun.sleep(50)
  calls.length = 0
  await briefs.refresh()
  await briefs.refresh()
  expect(calls.filter(call => call.startsWith("children"))).toEqual(["children ses_fdbrief_0", "children ses_fdbrief_0"])
})

test("an anchor with an unfinished brief reads its directory status and keeps the brief between polls", async () => {
  const { briefs, calls } = start(id => id === "ses_fdbrief_3" ? [brief("ses_fdjob_x", "/es/3")] : [])
  await Bun.sleep(50)
  expect(calls).toContain("status /es/3")
  expect(briefs.jobs().map(job => job.id)).toEqual(["ses_fdjob_x"])
  calls.length = 0
  await briefs.refresh()
  // A live brief elsewhere keeps its anchor on the fast cadence.
  expect(calls).toContain("children ses_fdbrief_3")
  expect(briefs.jobs().map(job => job.id)).toEqual(["ses_fdjob_x"])
})
