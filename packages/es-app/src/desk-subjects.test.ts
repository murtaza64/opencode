import { expect, test } from "bun:test"
import type { MessageWithParts } from "./api"
import type { AttentionRecord } from "./attention"
import { attentionItem, briefCommands, briefComplete, briefPacket, briefState, requestLinks, safeSvg, type BriefMeta, type BriefResult } from "./desk"
import { answeredJob, currentJob, regeneratingJob, type BriefJob } from "./desk-session"

// A request shaped like a bulk review gate: nine service/config pull-request pairs, one with a prerequisite.
const SERVICES = ["alpha-backend", "beta-loader", "gamma-detector", "delta-pilot", "epsilon-copilot", "zeta-session", "eta-website", "theta-backend", "iota-backend"]
const pairs = SERVICES.map((name, index) => [`https://github.com/acme/${name}/pull/${100 + index}`, `https://github.com/acme/blueprints/pull/${8000 + index}`])
const record: AttentionRecord = {
  id: "att_pairs", editspace: "alpha", revision: 3, content_revision: 1, status: "open", kind: "decision", title: "Who should review the nine cleanup PR pairs?",
  context: ["Nine wrapper-removal pairs need human review. Reviewer routing only.", "REVIEW LINKS (service / paired config)",
    ...pairs.map(([service, config], index) => `- ${SERVICES[index]}: ${service} / ${config} .${index === 0 ? " Also needs prerequisite approvals on 88/97." : ""}`)].join("\n"),
  options: [{ id: "name-reviewers", label: "Name reviewers", input: { kind: "text", label: "Reviewers", required: true } }, { id: "arrange-myself", label: "Arrange reviews myself" }],
  recommendation: "name-reviewers", producer_session: "ses_p", origin_session: "ses_p", gate_key: "cleanup", source_ref: { session_id: "ses_src", directory: "/alpha" },
  decision: null, delivery_state: "not-requested", created_at: 1, updated_at: 1,
}
const item = attentionItem(record, 0)
const reply = (value: unknown, contract = 4) => {
  const packet = briefPacket(item, [])
  const meta: BriefMeta = { kind: "brief", requestID: "r", source: item.key, revision: item.revision, title: record.title, refs: packet.refs, contract }
  const messages = [{ info: { id: "msg_u", role: "user" }, parts: [{ type: "text", text: packet.text }] },
    { info: { id: "msg_a", role: "assistant", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: JSON.stringify(value) }] }] as unknown as MessageWithParts[]
  const state = briefState(meta, messages, "idle")
  if (state.state !== "ready") throw Error(`not ready: ${JSON.stringify(state)}`)
  return state.result
}
const choices = [{ id: "name-reviewers", outcome: "Only the named reviewers are assigned." }, { id: "arrange-myself", outcome: "Nothing is assigned." }]
const everySubject = SERVICES.map((name, index) => ({ name, ...(index === 0 ? { detail: "also needs prerequisites 88 and 97" } : {}), refs: [`U${index * 2 + 1}`, `U${index * 2 + 2}`] }))

test("a brief is keyed to the request's content, not its status", () => {
  expect(item.revision).toBe("1")
})

test("every link the request gives reaches the brief job as a citable ref, in order", () => {
  const packet = briefPacket(item, [])
  expect(requestLinks(item)).toEqual(pairs.flat())
  expect(packet.refs.filter(ref => ref.id.startsWith("U")).map(ref => [ref.id, ref.url])).toEqual(pairs.flat().map((url, index) => [`U${index + 1}`, url]))
  expect(packet.text).toContain(`[U18] ${pairs[8]![1]}`)
  expect(packet.text).toContain("option name-reviewers requires input: Reviewers (text)")
})

test("a brief that reduces the listed services to a count does not stand in for the request", () => {
  const counted = reply({ question: "Who should review the nine cleanup pairs?", choices, shape: { kind: "scope", included: ["Choose reviewers"], excluded: ["Approve code"] } })
  expect(briefComplete(counted, item)).toBe(false)
  const missingOne = reply({ question: "Who reviews these?", choices, subjects: everySubject.slice(0, 8) })
  expect(briefComplete(missingOne, item)).toBe(false)
})

test("a brief that names every service with both of its links stands in for the request", () => {
  const result = reply({ question: "Who should review these nine cleanup pairs?", choices, subjects: [...everySubject, { name: "Invented", refs: ["U99"] }] })
  expect(briefComplete(result, item)).toBe(true)
  expect(result.subjects).toHaveLength(9)
  expect(result.subjects[0]).toEqual({ name: "alpha-backend", detail: "also needs prerequisites 88 and 97", refs: ["U1", "U2"] })
})

test("contract-4 visuals are mobile-first SVG with a description; anything else is dropped", () => {
  const svg = '<svg viewBox="0 0 360 240" xmlns="http://www.w3.org/2000/svg"><rect width="360" height="240" style="fill:var(--surface)"/><text x="8" y="20" style="fill:var(--fg)">Flow</text></svg>'
  expect(reply({ question: "Q?", choices, subjects: everySubject, visual: { title: "Flow", svg, alt: "A two-step flow." } }).visual).toEqual({ title: "Flow", alt: "A two-step flow.", svg, aspect: 240 / 360 })
  for (const bad of [
    svg.replace("0 0 360 240", "0 0 640 240"),
    svg.replace("<svg ", '<svg width="640" '),
    svg.replace("</svg>", "<script>1</script></svg>"),
    svg.replace("</svg>", '<foreignObject><div/></foreignObject></svg>'),
    svg.replace("<rect ", '<rect onclick="x()" '),
    svg.replace("</svg>", '<image href="https://x/y.png"/></svg>'),
    svg.replace("fill:var(--surface)", "fill:url(https://x/p)"),
    "<div>html</div>",
  ]) expect(reply({ question: "Q?", choices, visual: { title: "Flow", svg: bad, alt: "A flow." } }).visual).toBeUndefined()
  expect(reply({ question: "Q?", choices, visual: { title: "Flow", svg } }).visual).toBeUndefined()
  expect(safeSvg(svg.replace("0 0 360 240", "0 0 300 188"), 300, 188, 6000)).toBe(188 / 300)
})

test("briefs from the previous contract keep their HTML visual", () => {
  expect(reply({ question: "Q?", choices, visual: { title: "Old", html: "<div>x</div>", height: 200 } }, 3).visual).toEqual({ title: "Old", alt: "", html: "<div>x</div>", height: 200 })
})

test("compare keeps one cell per column, cut to the contract's sizes", () => {
  const result = reply({ question: "Q?", choices, shape: { kind: "compare", columns: ["name-reviewers", "arrange-myself"], rows: [{ label: "Who assigns", cells: ["The agent", "You"] }, { label: "Short", cells: ["only one"] }] } })
  expect(result.shape).toEqual({ kind: "compare", columns: ["name-reviewers", "arrange-myself"], rows: [{ label: "Who assigns", cells: ["The agent", "You"] }, { label: "Short", cells: ["only one", ""] }] })
})

test("the newest attempt is shown, but a ready brief stays while a regenerated one is prepared", () => {
  const job = (id: string, created: number, state: BriefJob["state"]): BriefJob => ({ id, directory: "/alpha", created, state,
    meta: { kind: "brief", requestID: id, source: item.key, revision: "1", title: "t", refs: [], contract: 4 } })
  const ready = { state: "ready", result: {} as BriefResult, omitted: 0 } as const
  const first = job("ses_fdjob_1", 1, ready)
  const second = job("ses_fdjob_2", 2, { state: "running" })
  expect(currentJob([first, second], item)?.id).toBe("ses_fdjob_1")
  expect(regeneratingJob([first, second], item)).toBe(true)
  const done = job("ses_fdjob_2", 2, ready)
  expect(currentJob([first, done], item)?.id).toBe("ses_fdjob_2")
  expect(regeneratingJob([first, done], item)).toBe(false)
  // An answer made after snooze/wake (revision 3) still finds the brief made for content 1.
  expect(answeredJob([first, done], item, { revision: 3 })?.id).toBe("ses_fdjob_2")
  expect(answeredJob([first, done], item, { revision: 3, brief: { job: "ses_fdjob_1" } })?.id).toBe("ses_fdjob_1")
})

test("a command is shown only when quoted exactly from the request; paraphrased or invented ones are dropped", () => {
  const command = `ssh -t me@mini 'zsh -lc "cd ~/dotfiles && es agent resume ses_x --task \\"Reply once\\""'`
  const moving = attentionItem({ ...record, id: "att_move", context: `Option 1: run on the laptop: ${command} then ~30 min test.` }, 0)
  const result = { ...reply({ question: "Q?", choices, subjects: everySubject }), commands: [] as BriefResult["commands"] }
  const exact = { label: "Resume the Mini pilot", where: "laptop terminal", option: "name-reviewers", command }
  expect(briefCommands({ ...result, commands: [exact] }, moving)).toEqual([exact])
  expect(briefCommands({ ...result, commands: [{ ...exact, command: "ssh me@mini es agent resume ses_x" }] }, moving)).toEqual([])
  expect(briefCommands({ ...result, commands: [{ ...exact, command: "rm -rf ~" }] }, moving)).toEqual([])
  // A command quoted only in a named document counts too.
  expect(briefCommands({ ...result, commands: [{ ...exact, command: "make deploy" }] }, moving, [{ name: "runbook.md", text: "then run make deploy" }])).toHaveLength(1)
})

test("commands survive parsing whole, without whitespace or quote rewriting", () => {
  const command = `printf '%s\\n'  "a  b"`
  expect(reply({ question: "Q?", choices, commands: [{ label: "Print", command: `  ${command}\n` }, { label: "", command: "x" }] }).commands).toEqual([{ label: "Print", where: "", option: "", command }])
})
