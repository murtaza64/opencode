import { expect, test } from "bun:test"
import type { AttentionRecord } from "./attention"
import type { MessageWithParts } from "./api"
import { authorityStrip, briefSemantics, HUD, hudPages, pictureNodes } from "./brief-view"
import { attentionItem, briefPacket, briefState, type BriefMeta, type BriefResult, type BriefScene } from "./desk"

// Synthetic fixtures only: no Work brief, source or history.
const record = (extra: Partial<AttentionRecord> = {}): AttentionRecord => ({
  id: "att_1", editspace: "alpha", revision: 2, status: "open", kind: "decision", title: "Ship the cache change?", context: "Canary healthy for a day.",
  options: [{ id: "go", label: "Go ahead" }, { id: "wait", label: "Wait a week" }], recommendation: "go", producer_session: "ses_p", origin_session: "ses_p",
  gate_key: "cache", source_ref: { session_id: "ses_src", directory: "/alpha" }, decision: null, delivery_state: "not-requested", created_at: 1, updated_at: 1, ...extra,
} as AttentionRecord)
const result = (extra: Partial<BriefResult> = {}): BriefResult => ({
  question: "Turn the faster cache on for everyone?", context: "", subjects: [], commands: [], steps: [], items: [], ifWait: "", sends: "", sendsTo: "", sendsAs: "", copy: [],
  sources: [], timeline: [],
  choices: [{ id: "go", label: "Go ahead", outcome: "Everyone gets faster pages", note: "Rollback is one flag" }, { id: "wait", label: "Wait a week", outcome: "Only the canary has it", note: "" }],
  facts: [{ text: "Canary error rate unchanged for 24 h", refs: ["C1"] }], gaps: ["Cost at full traffic is not measured."], ...extra,
})
const item = (extra: Partial<AttentionRecord> = {}) => attentionItem(record(extra), 1)

test("a brief's meaning is one ordered node list: item, authority, question, options, risks, evidence, unknowns, state", () => {
  const view = briefSemantics(item(), result(), { host: "mini", asOf: 5 })
  expect(view.item).toEqual({ key: "attention:alpha:att_1", host: "mini", revision: "2", title: "Ship the cache change?" })
  expect(view.nodes.map(node => [node.id, node.group, node.mark])).toEqual([
    ["item", "item", undefined], ["authority", "authority", undefined], ["question", "question", undefined], ["option:go", "option", "recommended"], ["option:wait", "option", undefined],
    ["risk:go", "risk", undefined], ["evidence:0", "evidence", undefined], ["unknown:0", "unknown", undefined], ["state", "state", undefined]])
  // "as of" reads in the viewer's zone (es-desktop-local-timezone), here pinned to New York.
  const zone = process.env.TZ
  process.env.TZ = "America/New_York"
  expect(briefSemantics(item(), result(), { host: "mini", asOf: 5 }).nodes.find(node => node.id === "state")!.text).toMatch(/^open · revision 2 · as of Dec 31,? (at )?0?7:00 PM$/)
  process.env.TZ = zone
})

test("a recorded answer marks its option as chosen; the recommendation stays labelled as a recommendation", () => {
  const view = briefSemantics(item({ status: "answered", answer: { choice_id: "wait" } as AttentionRecord["answer"] }), result())
  expect(view.nodes.filter(node => node.mark).map(node => [node.id, node.mark])).toEqual([["option:go", "recommended"], ["option:wait", "chosen"]])
  expect(view.nodes.at(-1)!.text).toBe("answered · answered Wait a week · revision 2 · as of unknown")
})

test("the HUD shows the same nodes in the same order on 48-column pages with title and pager", () => {
  const view = briefSemantics(item(), result())
  const pages = hudPages(view)
  const order = pages.flatMap(page => page.lines.map(line => line.node)).filter((node, index, all) => all.indexOf(node) === index)
  expect(order).toEqual(view.nodes.filter(node => node.group !== "item" && node.group !== "state").map(node => node.id))
  for (const page of pages) {
    expect(page.lines.length).toBeLessThanOrEqual(HUD.rows - 2)
    for (const text of [page.title, page.pager, ...page.lines.map(line => line.text)]) expect(text.length).toBeLessThanOrEqual(HUD.columns)
  }
  expect(pages[0]!.title).toBe("Ship the cache change?")
  expect(pages[0]!.pager).toBe(`1/${pages.length} · open · revision 2 · as of unknown`)
  expect(pages[0]!.lines.find(line => line.node === "option:go")!.text).toContain("Go ahead")
  expect(pages.flatMap(page => page.lines.map(line => line.text)).join("\n")).toContain("(rec)")
})

test("paging is deterministic and starts a node on a fresh page rather than splitting it when it fits one", () => {
  const view = briefSemantics(item(), result({ facts: Array.from({ length: 6 }, (_, index) => ({ text: `Fact ${index}: ${"word ".repeat(12)}`, refs: [] })) }))
  const pages = hudPages(view)
  expect(hudPages(view)).toEqual(pages)
  for (const node of new Set(pages.flatMap(page => page.lines.map(line => line.node)))) {
    const where = pages.map(page => page.lines.some(line => line.node === node))
    expect(where.filter(Boolean).length).toBe(1)
  }
})

test("a brief too dense for the glasses ends with where to read the rest, not smaller text", () => {
  const view = briefSemantics(item(), result({ facts: Array.from({ length: 40 }, (_, index) => ({ text: `Fact ${index} ${"long ".repeat(15)}`, refs: [] })) }), { host: "mini" })
  const pages = hudPages(view)
  expect(pages.length).toBe(HUD.maxPages)
  expect(pages.at(-1)!.lines.map(line => line.text).join(" ")).toContain("More on the desk: mini~attention:alpha:att_1")
  expect(pages.at(-1)!.pager).toBe(`${HUD.maxPages}/${HUD.maxPages} · open · revision 2 · as of unknown`)
})

test("a word longer than a line is split, never overflowing the glasses", () => {
  const pages = hudPages(briefSemantics(item(), result({ gaps: ["x".repeat(130)] })))
  for (const line of pages.flatMap(page => page.lines)) expect(line.text.length).toBeLessThanOrEqual(HUD.columns)
})

test("numbered request items keep their ids and order as their own nodes and page deterministically", () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({ id: `D${index + 1}`, question: `Decision ${index + 1} about the keyboard?`, recommended: "yes", alternatives: ["no"], refs: [] }))
  const view = briefSemantics(item({ context: rows.map(row => `${row.id}. ${row.question} Recommended: yes. Alternative: no.`).join("\n") }), result({ items: rows }))
  expect(view.nodes.filter(node => node.group === "row").map(node => node.id)).toEqual(rows.map(row => `row:${row.id}`))
  expect(view.nodes.map(node => node.group).indexOf("row")).toBe(3)
  const pages = hudPages(view)
  expect(pages.length).toBeGreaterThan(1)
  expect(pages.flatMap(page => page.lines.filter(line => line.node.startsWith("row:")).map(line => line.text))[0]).toBe("D1 Decision 1 about the keyboard? → yes (or no)")
})

test("an item value the request does not quote reads as not given, as on the desktop card", () => {
  const view = briefSemantics(item({ context: "D1. Which key? Recommended: Alt." }), result({ items: [{ id: "D1", question: "Which key?", recommended: "Ctrl", alternatives: ["Super"], refs: [] }, { id: "D9", question: "Invented?", recommended: "x", alternatives: [], refs: [] }] }))
  expect(view.nodes.filter(node => node.group === "row").map(node => node.text)).toEqual(["D1 Which key? → not given"])
})

test("a compare picture becomes a head and one node per aspect, columns only for real options", () => {
  const nodes = pictureNodes(result({ shape: { kind: "compare", columns: ["go", "ghost", "wait"], rows: [{ label: "Who gets it", cells: ["Everyone", "x", "Canary only"] }] } }), item())
  expect(nodes.map(node => [node.id, node.text])).toEqual([["picture:head", "Go ahead (rec) | Wait a week"], ["picture:row:0", "Who gets it: Everyone | Canary only"]])
})

test("a sequence keeps the approval scope as a description on the same steps for both views", () => {
  const nodes = pictureNodes(result({ shape: { kind: "sequence", steps: ["Canary", "Half", "All"], approved: 1 } }), item())
  expect(nodes.map(node => node.text)).toEqual(["1. Canary [approving covers step 1]", "2. Half [later steps need their own decision]", "3. All"])
  expect(nodes.map(node => node.part && "later" in node.part && node.part.later)).toEqual([false, true, true])
})

test("more than two unchanged rows fold into one node, as on the card", () => {
  const rows = [{ item: "A", now: "1", after: "2" }, ...["B", "C", "D"].map(name => ({ item: name, now: "x", after: "x" }))]
  expect(pictureNodes(result({ shape: { kind: "change", rows } }), item()).map(node => node.text)).toEqual(["A: 1 → 2", "3 other things stay the same"])
})

test("the model's own drawing is one described node; the glasses never claim to draw it", () => {
  const nodes = pictureNodes(result({ visual: { title: "Rollout", alt: "Three stages left to right", svg: "<svg/>" }, shape: { kind: "impact", rows: [{ area: "a", change: "b" }] } }), item())
  expect(nodes.map(node => [node.id, node.text])).toEqual([["picture:visual", "Picture: Three stages left to right (drawn on the desk)"]])
})

test("picture nodes sit before the options, as the card draws them, and before risks", () => {
  const view = briefSemantics(item(), result({ shape: { kind: "scope", included: ["web"], excluded: ["mobile"] } }))
  expect(view.nodes.map(node => node.id)).toEqual(["item", "authority", "question", "picture:in:0", "picture:out:0", "option:go", "option:wait", "risk:go", "evidence:0", "unknown:0", "state"])
})

test("the authority strip keeps record state apart from the recommendation and from any recorded choice", () => {
  expect(authorityStrip(item())).toEqual(["OPEN request", "◇ option 1 recommended", "no option chosen"])
  expect(briefSemantics(item(), result()).nodes.find(node => node.id === "authority")!.text).toBe("[OPEN request · ◇ option 1 recommended · no option chosen]")
})

test("a recorded choice reads as recorded, never as carried out", () => {
  expect(authorityStrip(item({ status: "resolved", answer: { choice_id: "wait", text: "" } as AttentionRecord["answer"] })))
    .toEqual(["RECORD CLOSED", "◇ option 1 recommended", "✓ option 2 = recorded choice, execution unverified"])
})

test("a record closed or withdrawn without a recorded option says its outcome is unverified", () => {
  expect(authorityStrip(item({ status: "withdrawn" }))).toEqual(["WITHDRAWN record", "◇ option 1 recommended", "no option chosen", "outcome unverified"])
  expect(authorityStrip(item({ status: "resolved", answer: { choice_id: null, text: "Ask the owners first" } as AttentionRecord["answer"] })))
    .toEqual(["RECORD CLOSED", "◇ option 1 recommended", "answered in words, no option chosen", "outcome unverified"])
})

test("the glasses show the authority strip first, wrapped, never clipped", () => {
  const pages = hudPages(briefSemantics(item({ status: "resolved", answer: { choice_id: "wait", text: "" } as AttentionRecord["answer"] }), result()))
  const strip = pages[0]!.lines.filter(line => line.node === "authority").map(line => line.text)
  expect(pages[0]!.lines[0]!.node).toBe("authority")
  expect(strip.join(" ").replace(/\s+/g, " ")).toBe("[RECORD CLOSED · ◇ option 1 recommended · ✓ option 2 = recorded choice, execution unverified]")
})

// A synthetic communication request: a reply into an existing thread; who would send it is not stated.
const POST = "Post one reply in the existing release thread in #cache-team, where Ana and Raj were previously involved. Ask who owns the rollback plan. This permits only that reply: no deploys."
const communication: BriefScene = {
  parts: [{ id: "sender", role: "unknown", name: "" }, { id: "slack", role: "platform", name: "Slack" }, { id: "channel", role: "channel", name: "#cache-team", in: "slack" },
    { id: "thread", role: "thread", name: "existing release thread", in: "channel" }, { id: "reply", role: "message", name: "who owns the rollback plan", in: "thread" },
    { id: "ana", role: "person", name: "Ana", in: "thread", note: "previously involved" }],
  relations: [{ from: "sender", to: "reply", kind: "sends", option: "go" }], limits: ["This permits only that reply: no deploys."],
}

test("a communication scene: unknown sender, the reply it would send into the thread, the thread inside its channel", () => {
  const nodes = pictureNodes(result({ scene: communication }), item({ context: POST }))
  expect(nodes.map(node => node.text)).toEqual([
    "? someone not stated", "- -> option 1 ◇ would send into ↳ existing release thread · no send receipt recorded",
    "platform not stated", "# #cache-team", "↳ existing release thread", "✉ who owns the rollback plan", "person Ana (previously involved)", "✕ This permits only that reply: no deploys."])
  expect(nodes.map(node => node.part && "depth" in node.part ? node.part.depth : undefined)).toEqual([0, 1, 0, 1, 2, 3, 3, undefined])
})

test("a scene name the request does not quote reads as not stated, never as a guessed actor or place", () => {
  const nodes = pictureNodes(result({ scene: { ...communication, parts: communication.parts.map(part => part.id === "sender" ? { ...part, role: "person" as const, name: "Release bot" } : part) } }), item({ context: POST }))
  expect(nodes[0]!.text).toBe("person not stated")
  expect(nodes.find(node => node.id === "picture:part:slack")!.text).toBe("platform not stated")
})

test("a requested capability across a boundary is never granted; a recorded choice leaves the grant unverified", () => {
  const scene: BriefScene = { parts: [{ id: "worker", role: "identity", name: "build-worker", note: "also used by PR builds" }, { id: "deployer", role: "identity", name: "deploy-only" },
    { id: "account", role: "boundary", name: "prod account" }, { id: "role", role: "capability", name: "restart-role", in: "account" }],
    relations: [{ from: "worker", to: "role", kind: "requests", label: "AssumeRole", option: "wait" }, { from: "deployer", to: "role", kind: "requests", label: "AssumeRole", option: "go" }], limits: [] }
  const context = "Let build-worker (also used by PR builds) or a new deploy-only identity AssumeRole restart-role in the prod account."
  expect(pictureNodes(result({ scene }), item({ context })).map(node => node.text)).toEqual([
    "id build-worker (also used by PR builds)", "- -> option 2 requests AssumeRole on key restart-role · not granted",
    "id deploy-only", "- -> option 1 ◇ requests AssumeRole on key restart-role · not granted", "inside prod account", "key restart-role"])
  const chosen = pictureNodes(result({ scene }), item({ context, status: "resolved", answer: { choice_id: "go", text: "" } as AttentionRecord["answer"] }))
  expect(chosen.find(node => node.id === "picture:relation:1")!.text).toBe("- -> option 1 ✓ requests AssumeRole on key restart-role · grant unverified")
})

test("the glasses keep a scene's nesting as indentation, in the card's order", () => {
  const view = briefSemantics(item({ context: POST }), result({ scene: communication }))
  const lines = hudPages(view).flatMap(page => page.lines).filter(line => line.node.startsWith("picture:"))
  expect(lines.find(line => line.node === "picture:part:thread")!.text).toBe("    ↳ existing release thread")
  expect(lines.find(line => line.node === "picture:part:reply")!.text).toBe("      ✉ who owns the rollback plan")
  for (const line of lines) expect(line.text.length).toBeLessThanOrEqual(HUD.columns)
})

test("a typed scene is the picture even when a drawing or shape is also given", () => {
  const nodes = pictureNodes(result({ scene: communication, visual: { title: "x", alt: "y", svg: "<svg/>" }, shape: { kind: "scope", included: ["a"], excluded: [] } }), item({ context: POST }))
  expect(nodes[0]!.id).toBe("picture:part:sender")
})

test("a scene from a brief reply keeps only parts, nesting and relations that refer to listed parts", () => {
  const record = { id: "att_s", editspace: "alpha", revision: 1, status: "open", kind: "decision", title: "Ask the owners?", context: POST, options: [{ id: "go", label: "Post" }], recommendation: "go",
    producer_session: "ses_p", origin_session: "ses_p", gate_key: "s", source_ref: { session_id: "ses_src", directory: "/alpha" }, decision: null, delivery_state: "not-requested", created_at: 1, updated_at: 1 } as AttentionRecord
  const packet = briefPacket(attentionItem(record, 0), [])
  const meta: BriefMeta = { kind: "brief", requestID: "r", source: "attention:alpha:att_s", revision: "1", title: record.title, refs: packet.refs, contract: 4 }
  const scene = { parts: [{ id: "t", role: "thread", name: "existing release thread", in: "later" }, { id: "m", role: "message", name: "x", in: "t" }, { id: "b", role: "robot", name: "Bot" }, { id: "t", role: "channel", name: "dup" }],
    relations: [{ from: "m", to: "ghost", kind: "sends" }, { from: "m", to: "t", kind: "grants" }], limits: ["no deploys", 4] }
  const messages = [{ info: { id: "msg_u", role: "user" }, parts: [{ type: "text", text: packet.text }] },
    { info: { id: "msg_a", role: "assistant", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: JSON.stringify({ question: "Ask?", choices: [{ id: "go", outcome: "Reply posted" }], scene }) }] }] as unknown as MessageWithParts[]
  const state = briefState(meta, messages, "idle")
  if (state.state !== "ready") throw Error(state.state)
  expect(state.result.scene).toEqual({ parts: [{ id: "t", role: "thread", name: "existing release thread" }, { id: "m", role: "message", name: "x", in: "t" }], relations: [], limits: ["no deploys"] })
})

test("workloads that run as a shared identity are drawn under it, so a grant to it shows everything it reaches", () => {
  const scene: BriefScene = { parts: [{ id: "worker", role: "identity", name: "build-worker" }, { id: "pr", role: "app", name: "PR builds" }, { id: "deployer", role: "identity", name: "deploy-only" },
    { id: "account", role: "boundary", name: "prod account" }, { id: "role", role: "capability", name: "restart-role", in: "account" }],
    relations: [{ from: "pr", to: "worker", kind: "uses" }, { from: "worker", to: "role", kind: "requests", label: "AssumeRole", option: "wait" }, { from: "deployer", to: "role", kind: "requests", label: "AssumeRole", option: "go" }], limits: [] }
  const nodes = pictureNodes(result({ scene }), item({ context: "build-worker also runs PR builds; a deploy-only identity could AssumeRole restart-role in the prod account instead." }))
  expect(nodes.map(node => node.text)).toEqual(["id build-worker", "app PR builds · runs as build-worker", "- -> option 2 requests AssumeRole on key restart-role · not granted",
    "id deploy-only", "- -> option 1 ◇ requests AssumeRole on key restart-role · not granted", "inside prod account", "key restart-role"])
  expect(nodes[1]!.part).toMatchObject({ role: "entity", runs: "worker", depth: 1 })
  expect(nodes[2]!.part).toMatchObject({ role: "relation", verb: "requests AssumeRole", state: "not granted" })
})
