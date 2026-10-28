import { expect, test } from "bun:test"
import fixture from "./notify.fixture.json"
import { reconcile, type AttentionItem, type Ledger, type RequestItem } from "./notify"

// Shared with the Android port: each case is one host's current items plus this device's ledger.
for (const item of fixture as unknown as {
  name: string
  origin: string
  now?: number
  attention: AttentionItem[]
  requests: RequestItem[]
  ledger: Ledger
  want: [string, string][]
  want_ledger?: Ledger
}[]) {
  test(item.name, () => {
    const result = reconcile({ origin: item.origin, attention: item.attention, requests: item.requests, ledger: item.ledger, now: item.now ?? 0 })
    expect(result.actions.map((action) => [action.op, action.tag])).toEqual(item.want)
    if (item.want_ledger) expect(result.ledger).toEqual(item.want_ledger)
  })
}

test("a posted decision carries the record reference a click needs", () => {
  const result = reconcile({
    origin: "https://mini:8443",
    attention: [{ id: "att_1", editspace: "opencode", status: "open", revision: 2, content_revision: 2, title: "Pick a reviewer" }],
    requests: [],
    ledger: {},
    now: 0,
  })
  expect(result.actions).toEqual([
    { op: "post", tag: "https://mini:8443|opencode|att:att_1", kind: "decision", editspace: "opencode", id: "att_1", revision: 2, title: "Pick a reviewer" },
  ])
})
