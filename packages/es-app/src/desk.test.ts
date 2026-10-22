import { expect, test } from "bun:test"
import type { SessionFailure } from "@opencode-ai/sdk/v2"
import type { MessageWithParts } from "./api"
import type { AttentionRecord } from "./attention"
import { briefBinding, briefPacket, briefState, deskContext, deskItems, deskSources, type BriefMeta, type DeskItem } from "./desk"

const record = (revision: number, status: AttentionRecord["status"] = "open"): AttentionRecord => ({
  id: "att_1", editspace: "alpha", revision, status, kind: "decision", title: "Pick a rollout", context: "Two options remain.",
  options: [{ id: "a", label: "Canary" }, { id: "b", label: "Full" }], recommendation: "a", producer_session: "ses_p", origin_session: "ses_p",
  gate_key: "rollout", source_ref: { session_id: "ses_src", directory: "/alpha" }, decision: null, delivery_state: "not-requested",
  created_at: 1, updated_at: 1,
})
const failure: SessionFailure = { sessionID: "ses_f", directory: "/alpha", messageID: "msg_f1", parentID: "msg_u", time: 1, error: { name: "APIError", statusCode: 403 }, retry: "available" }
const items = (revision = 2) => deskItems({
  records: [record(revision), { ...record(1), id: "att_closed", status: "resolved" }],
  attentionChecked: 100,
  requests: [{ kind: "question", id: "que_1", session: "ses_q", directory: "/beta", title: "Which branch?", project: "beta", state: "pending", checked: 90 },
    { kind: "question", id: "que_gone", session: "ses_q", directory: "/beta", title: "Gone", state: "unknown", checked: 90 }],
  failures: [failure],
  failuresChecked: 80,
  title: (id) => (id === "ses_f" ? "Deploy agent" : undefined),
  project: () => "alpha",
})
const message = (id: string, role: "user" | "assistant", text: string, extra: Record<string, unknown> = {}) => ({
  info: { id, role, sessionID: "ses_src", time: { created: 1, completed: 2 }, ...extra },
  parts: [{ id: `prt_${id}`, type: "text", text, sessionID: "ses_src", messageID: id }],
}) as unknown as MessageWithParts
const meta = (revision = "2"): BriefMeta => ({ kind: "brief", requestID: "req_1", source: "attention:alpha:att_1", revision, title: "Pick a rollout", refs: [{ id: "C1", label: "canonical" }, { id: "E1", label: "assistant", messageID: "msg_1" }] })

test("queue lists only pending requests from every connected source with their own revision identity", () => {
  expect(items().map((item) => [item.key, item.kind, item.revision])).toEqual([
    ["attention:alpha:att_1", "decision", "2"],
    ["question:/beta:que_1", "question", "que_1"],
    ["failure:ses_f", "failure", "msg_f1"],
  ])
  expect(items()[2]!.title).toBe("Deploy agent")
})

test("sources disclose partial, stale and unsupported inputs instead of reporting an empty desk", () => {
  const sources = deskSources({
    now: 100_000,
    attention: { checked: 99_000, error: "", unavailable: [{ editspace: "beta", error: "ledger offline" }], truncated: false, operator: false },
    requests: { rows: [{ kind: "question", id: "q", session: "s", directory: "/d", title: "t", state: "pending", checked: 1_000 }], error: "" },
    failures: { supported: false, error: "" },
    dashboard: { stateError: "Dashboard source unavailable" },
  })
  expect(sources.map((source) => [source.name, source.state])).toEqual([
    ["Attention ledger", "partial"],
    ["Native permissions and questions", "stale"],
    ["Failed sessions", "unavailable"],
    ["Dashboard state", "unavailable"],
  ])
  expect(sources[0]!.detail).toBe("beta: ledger offline; read-only: operator connection unavailable")
})

test("context note is bounded, names the selection explicitly and changes key only when the view changes", () => {
  const many: DeskItem[] = Array.from({ length: 30 }, (_, index) => ({ ...items()[0]!, key: `attention:alpha:${index}`, title: "x".repeat(400) }))
  const general = deskContext({ now: 0, sources: [], items: many, briefs: [] })
  expect(general.text).toContain("selected item: none")
  expect(general.text).toContain("… 18 more not listed")
  expect(general.text.length).toBeLessThanOrEqual(10_000)
  const selected = deskContext({ now: 5, sources: [], items: many, selected: items()[0], briefs: [] })
  expect(selected.text).toContain("options: a=Canary; b=Full")
  expect(selected.text).toContain("recommended option: a")
  expect(selected.key).not.toBe(general.key)
  expect(deskContext({ now: 99_999, sources: [], items: many, briefs: [] }).key).toBe(general.key)
})

test("context key changes when the queue, a revision or source health changes, but not with time", () => {
  const source = { name: "Attention ledger", state: "current" as const, checked: 1 }
  const key = (input: { items?: DeskItem[]; state?: "current" | "unavailable"; checked?: number; now?: number }) =>
    deskContext({ now: input.now ?? 0, sources: [{ ...source, state: input.state ?? "current", checked: input.checked ?? 1 }], items: input.items ?? items(2), briefs: [] }).key
  const base = key({})
  expect(key({ now: 50_000, checked: 40_000 })).toBe(base)
  expect(key({ items: items(3) })).not.toBe(base)
  expect(key({ items: items(2).slice(1) })).not.toBe(base)
  expect(key({ state: "unavailable" })).not.toBe(base)
})

test("brief packet keeps the newest evidence within budget and numbers its refs", () => {
  const tail = Array.from({ length: 20 }, (_, index) => message(`msg_${String(index).padStart(2, "0")}`, index % 2 ? "assistant" : "user", `step ${index} ${"y".repeat(480)}`))
  const packet = briefPacket(items()[0]!, tail)
  expect(packet.refs[0]).toEqual({ id: "C1", label: "canonical decision attention:alpha:att_1 rev 2" })
  expect(packet.refs.at(-1)?.messageID).toBe("msg_19")
  expect(packet.refs.length).toBeLessThan(21)
  expect(packet.text).toContain("older excerpt(s) omitted")
  expect(packet.text).toContain("[C1] Canonical request")
})

test("brief state keeps only cited facts and resolvable sources from the JSON reply", () => {
  const reply = JSON.stringify({ ask: "", whyYou: "  It reads production storage  ", whyNow: "Latency rose Tuesday",
    choices: [{ id: "a", outcome: "Canary keeps 5%", chips: ["read-only", "~90 min", "extra"], risk: "Slower" }], ifWait: "", unknown: "Owner unknown",
    sources: [{ label: "Latency report", refs: ["E1"] }, { label: "Invented", refs: ["E9"] }, { label: "Plan", refs: ["file:docs/plan.md"] }],
    facts: [{ text: "Canary exists", refs: ["E1"] }, { text: "Invented", refs: ["E9"] }], timeline: [], gaps: ["Cost"] })
  const state = briefState(meta(), [message("msg_u", "user", "packet"), message("msg_a", "assistant", "```json\n" + reply + "\n```")], "idle")
  expect(state).toEqual({ state: "ready", omitted: 1, result: { ask: "", whyYou: "It reads production storage", whyNow: "Latency rose Tuesday",
    choices: [{ id: "a", outcome: "Canary keeps 5%", chips: ["read-only", "~90 min"], risk: "Slower" }], ifWait: "", unknown: "Owner unknown", gaps: ["Cost"],
    sources: [{ label: "Latency report", refs: ["E1"] }, { label: "Plan", refs: ["file:docs/plan.md"] }],
    facts: [{ text: "Canary exists", refs: ["E1"] }], timeline: [] } })
})

test("brief state keeps one well-formed shape and drops malformed ones", () => {
  const ready = (shape: unknown) => {
    const reply = JSON.stringify({ ask: "Approve the probe?", choices: [], ifWait: "", unknown: "", sources: [], facts: [], shape })
    const state = briefState(meta(), [message("msg_u", "user", "packet"), message("msg_a", "assistant", reply)], "idle")
    return state.state === "ready" ? state.result.shape : "not ready"
  }
  expect(ready({ kind: "scope", included: ["Read-only S3 reads", 7], excluded: ["Deploys"] })).toEqual({ kind: "scope", included: ["Read-only S3 reads"], excluded: ["Deploys"] })
  expect(ready({ kind: "sequence", steps: ["Preflight", "Six runs", "Compare", "Report", "Decide", "Ship"] })).toEqual({ kind: "sequence", steps: ["Preflight", "Six runs", "Compare", "Report", "Decide"] })
  expect(ready({ kind: "impact", rows: [{ area: "CPU", change: "" }, { area: "Prod", change: "Untouched" }] })).toEqual({ kind: "impact", rows: [{ area: "Prod", change: "Untouched" }] })
  expect(ready({ kind: "sequence", steps: ["Only one"] })).toBeUndefined()
  expect(ready({ kind: "chart", data: [] })).toBeUndefined()
})

test("brief state strips bracketed ref citations from prose; refs stay attached", () => {
  const reply = JSON.stringify({ ask: "Ship the canary or wait (C1)?", choices: [{ id: "a", outcome: "Canary stays [E1, E2]", chips: [], risk: "" }], ifWait: "", unknown: "Cost (C1) unknown", sources: [],
    facts: [{ text: "Canary is healthy (E1).", refs: ["E1"] }], timeline: [] })
  const state = briefState(meta(), [message("msg_u", "user", "packet"), message("msg_a", "assistant", reply)], "idle")
  expect(state).toMatchObject({ state: "ready", result: { ask: "Ship the canary or wait?", choices: [{ outcome: "Canary stays" }], facts: [{ text: "Canary is healthy.", refs: ["E1"] }], unknown: "Cost unknown" } })
})

test("brief state reports interrupted and unconfirmed passes as unknown, never as running", () => {
  expect(briefState(meta(), [], "idle")).toEqual({ state: "unknown", reason: "Brief start not confirmed." })
  expect(briefState(meta(), [message("msg_u", "user", "packet")], undefined).state).toBe("unknown")
  expect(briefState(meta(), [message("msg_u", "user", "packet")], "busy").state).toBe("running")
  expect(briefState(meta(), [message("msg_u", "user", "packet"), message("msg_a", "assistant", "plain prose")], "idle"))
    .toEqual({ state: "failed", error: "no readable reply." })
  expect(briefState(meta(), [message("msg_u", "user", "packet"), message("msg_a", "assistant", "", { error: { name: "APIError" } })], "idle"))
    .toEqual({ state: "failed", error: "APIError" })
})

test("a brief binds to its initiating source revision, not to whatever is selected now", () => {
  expect(briefBinding(meta("2"), items(2)).current).toBe(true)
  expect(briefBinding(meta("2"), items(3))).toMatchObject({ current: false, reason: "Item changed (revision 2 → 3)." })
  expect(briefBinding({ ...meta(), source: "attention:alpha:other" }, items())).toMatchObject({ current: false, item: undefined })
})

test("an open surface is named in the context by its owner and changes the key; its content is never included", () => {
  const plain = deskContext({ now: 0, sources: [], items: items(), briefs: [] })
  const open = deskContext({ now: 0, sources: [], items: items(), briefs: [], surface: { id: "relay-board", title: "Relay board", owner: "Relay" } })
  expect(open.key).not.toBe(plain.key)
  expect(open.text).toContain('open surface: "Relay board" (id relay-board), maintained by Relay.')
  expect(plain.text).not.toContain("open surface")
})
