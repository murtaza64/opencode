import { expect, test } from "bun:test"
import { mailActivity, prActivity } from "./home-activity-data"

test("bare PR references never claim a merge", () => {
  expect(prActivity({ url: "https://github.com/example/repo/pull/1", number: 1, repo: "example/repo" }, 1000, "fixture")[0]).toMatchObject({ level: "minor", time: 1000, timeLabel: "cache observed" })
})

test("a confirmed merged snapshot without merge time labels only its cache observation", () => {
  expect(prActivity({ url: "https://github.com/example/repo/pull/1", number: 1, repo: "example/repo", state: "merged" }, 1000, "fixture")[0]).toMatchObject({ level: "major", time: 1000, timeLabel: "cache observed" })
})

test("untrusted PR URLs cannot become activity links", () => {
  expect(prActivity({ url: "javascript:alert(1)", number: 1, repo: "example/repo", state: "merged" }, 1000, "fixture")).toEqual([])
})

test("mail remains minor even when its text claims a merge", () => {
  expect(mailActivity({ id: "m1", ts: 1000, from: "agent-a", to: "agent-b", direction: "received", deliveries: [], text: "Merged everything" }, "fixture", 2000)).toMatchObject({ id: "mail:fixture:m1", level: "minor", kind: "mail" })
})

test("activity mail names its origin and a Squadron author instead of the bridge", () => {
  const bridged = { id: "m2", ts: 1000, from: "integration:squadron", to: "squadron-v2", direction: "received" as const, deliveries: [],
    text: "digest", squadron: { workspace_name: "ws", items: [{ kind: "message.created", persona: "smoke-peer" }] } }
  expect(mailActivity(bridged, "fixture", 2000).text.startsWith("Squadron · smoke-peer → squadron-v2")).toBe(true)
  expect(mailActivity({ ...bridged, from: "ses_abc", squadron: undefined }, "fixture", 2000).text.startsWith("Electric Sheep · ses_abc")).toBe(true)
  expect(mailActivity({ ...bridged, from: "Legacy", squadron: undefined }, "fixture", 2000).text.startsWith("Legacy → ")).toBe(true)
})
