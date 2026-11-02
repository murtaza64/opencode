/* One brief as an ordered set of nodes, the single source both projections read: the full-colour desktop card and a
 * glasses HUD page set (Even Realities G2, 576x288, one green). A node keeps its id, group and order in every projection;
 * a projection may only lay nodes out differently, page them, or point to the full brief elsewhere. Reading, paging or
 * speaking a node is never an answer: answers stay with the native decision controls. */
import { briefItems, briefScene, type BriefItem, type BriefResult, type BriefScene, type BriefShape, type ConversationDocument, type DeskItem, type SceneRole } from "./desk"

const MISSING = "not given"

export type BriefNodeGroup = "item" | "authority" | "question" | "row" | "option" | "picture" | "risk" | "evidence" | "unknown" | "state"
/** `id` is stable across projections and revisions of the same brief (option ids are the producer's own). */
export type BriefNode = { id: string; group: BriefNodeGroup; text: string; mark?: "recommended" | "chosen"
  /** Evidence refs (C1, E2…) for evidence nodes; the verified request item behind a row node. */
  refs?: string[]; row?: BriefItem; part?: PicturePart; strip?: string[] }

/** One element of a brief's picture, with its role, so every projection draws the same elements in the same order. */
export type PicturePart =
  | { role: "compare-head"; columns: { label: string; recommended: boolean }[] }
  | { role: "compare-row"; label: string; cells: string[] }
  | { role: "step"; index: number; text: string; scope?: "covered-last" | "later-first"; later: boolean; approved?: number }
  | { role: "change"; item: string; now: string; after: string }
  | { role: "change-same"; count: number; items: string[] }
  | { role: "in"; text: string }
  | { role: "out"; text: string }
  | { role: "impact"; area: string; change: string }
  | { role: "visual"; title: string; alt: string }
  /** A scene part at its nesting depth (0 = not inside anything); `name` empty = not stated in the request. */
  | { role: "entity"; id: string; entity: SceneRole; name: string; note?: string; parent?: string; depth: number; holds: boolean }
  /** A proposed relation, drawn under its source: never a send, grant or outcome that happened. */
  | { role: "relation"; kind: "sends" | "requests"; from: string; to: string; target: string; label?: string; option?: { number: number; mark?: "recommended" | "chosen" }; depth: number }
  | { role: "limit"; text: string }

/** A compare shape reduced to columns that are real options; fewer than two leaves nothing to compare. */
export const compareOf = (shape: Extract<BriefShape, { kind: "compare" }>, item: DeskItem) => {
  const options = item.record?.options ?? []
  const kept = shape.columns.flatMap((id, index) => { const option = options.find(candidate => candidate.id === id); return option ? [{ index, label: option.label, recommended: item.record?.recommendation === id }] : [] })
  if (kept.length < 2) return
  return { columns: kept, rows: shape.rows.map(row => ({ label: row.label, cells: kept.map(column => row.cells[column.index] ?? "") })) }
}

/** The picture as ordered nodes: the brief's own visual (described; drawn only where it can be), else the app-drawn
 * shape element by element. Same-as-now change rows fold into one node when more than two, as on the card. */
export const pictureNodes = (result: BriefResult, item: DeskItem, documents?: ConversationDocument[]): BriefNode[] => {
  const node = (id: string, text: string, part: PicturePart): BriefNode => ({ id: `picture:${id}`, group: "picture", text, part })
  // A typed scene is source-bound part by part, so it is preferred over a free drawing or a generic shape.
  const scene = briefScene(result, item, documents)
  if (scene) return sceneNodes(scene, item)
  if (result.visual) return [node("visual", `Picture: ${result.visual.alt || result.visual.title} (drawn on the desk)`, { role: "visual", title: result.visual.title, alt: result.visual.alt })]
  const shape = result.shape
  if (!shape) return []
  if (shape.kind === "compare") {
    const compare = compareOf(shape, item)
    if (!compare) return []
    return [node("head", compare.columns.map(column => `${column.label}${column.recommended ? " (rec)" : ""}`).join(" | "), { role: "compare-head", columns: compare.columns.map(({ label, recommended }) => ({ label, recommended })) }),
      ...compare.rows.map((row, index) => node(`row:${index}`, `${row.label}: ${row.cells.join(" | ")}`, { role: "compare-row", label: row.label, cells: row.cells }))]
  }
  if (shape.kind === "sequence") return shape.steps.map((step, index) => {
    const approved = shape.approved
    const scope = approved && index === approved - 1 ? "covered-last" as const : approved && index === approved ? "later-first" as const : undefined
    const note = scope === "covered-last" ? ` [approving covers ${approved === 1 ? "step 1" : `steps 1-${approved}`}]` : scope === "later-first" ? " [later steps need their own decision]" : ""
    return node(`step:${index}`, `${index + 1}. ${step}${note}`, { role: "step", index, text: step, later: !!approved && index >= approved, ...(scope ? { scope, approved } : {}) })
  })
  if (shape.kind === "change") {
    const same = shape.rows.filter(row => row.now === row.after)
    const shown = same.length > 2 ? shape.rows.filter(row => row.now !== row.after) : shape.rows
    return [...shown.map((row, index) => node(`change:${index}`, `${row.item}: ${row.now} → ${row.after}`, { role: "change", ...row })),
      ...(same.length > 2 ? [node("change:same", `${same.length} other things stay the same`, { role: "change-same", count: same.length, items: same.map(row => row.item) })] : [])]
  }
  if (shape.kind === "scope") return [...shape.included.map((text, index) => node(`in:${index}`, `In: ${text}`, { role: "in", text })),
    ...shape.excluded.map((text, index) => node(`out:${index}`, `Out: ${text}`, { role: "out", text }))]
  return shape.rows.map((row, index) => node(`impact:${index}`, `${row.area} → ${row.change}`, { role: "impact", ...row }))
}

/** How each role reads where it cannot be drawn (the glasses, a screen reader): a word or mark, never colour alone. */
export const SCENE_CUE: Record<SceneRole, { mark: string; noun: string }> = {
  unknown: { mark: "?", noun: "someone" }, person: { mark: "person", noun: "person" }, app: { mark: "app", noun: "app" }, identity: { mark: "id", noun: "identity" },
  platform: { mark: "on", noun: "platform" }, channel: { mark: "#", noun: "channel" }, thread: { mark: "↳", noun: "thread" }, boundary: { mark: "inside", noun: "boundary" },
  message: { mark: "✉", noun: "message" }, capability: { mark: "key", noun: "capability" }, queue: { mark: "queue", noun: "queue" },
}
// An unstated part keeps its symbol (?, #, ↳, ✉) but drops a word mark, which its noun already says.
const sceneLabel = (part: { role: SceneRole; name: string }) => {
  const cue = SCENE_CUE[part.role]
  if (part.name) return `${cue.mark} ${part.name}`
  return `${/^[a-z]+$/.test(cue.mark) ? "" : `${cue.mark} `}${cue.noun} not stated`
}

/** A scene as nodes, in reading order: parts that act come first, each followed by what it would do, then the places
 * and objects they act on, each container before what it holds; the request's limits last. */
const sceneNodes = (scene: BriefScene, item: DeskItem): BriefNode[] => {
  const options = item.record?.options ?? []
  const byId = (id: string) => scene.parts.find(part => part.id === id)!
  const inside = (id?: string) => scene.parts.filter(part => part.in === id)
  const acts = new Set(scene.relations.map(relation => relation.from))
  const walk = (part: BriefScene["parts"][number], depth: number): BriefNode[] => [
    { id: `picture:part:${part.id}`, group: "picture", text: `${sceneLabel(part)}${part.note ? ` (${part.note})` : ""}`,
      part: { role: "entity", id: part.id, entity: part.role, name: part.name, ...(part.note ? { note: part.note } : {}), ...(part.in ? { parent: part.in } : {}), depth, holds: inside(part.id).length > 0 } },
    ...scene.relations.flatMap((relation, index) => relation.from === part.id ? [relationNode(relation, index, depth)] : []),
    ...inside(part.id).flatMap(child => walk(child, depth + 1)),
  ]
  const relationNode = (relation: BriefScene["relations"][number], index: number, depth: number): BriefNode => {
    const to = byId(relation.to)
    // A message is sent into the place that holds it; anything else is named itself.
    const target = to.role === "message" && to.in ? sceneLabel(byId(to.in)) : sceneLabel(to)
    const at = options.findIndex(option => option.id === relation.option)
    const mark = at < 0 ? undefined : item.record?.answer?.choice_id === relation.option ? "chosen" as const : item.record?.recommendation === relation.option ? "recommended" as const : undefined
    const option = at < 0 ? "" : `option ${at + 1}${mark === "chosen" ? " ✓" : mark === "recommended" ? " ◇" : ""} `
    const action = relation.kind === "sends" ? `would send into ${target} · no send receipt recorded` : `requests ${relation.label ? `${relation.label} on ` : ""}${target} · ${mark === "chosen" ? "grant unverified" : "not granted"}`
    return { id: `picture:relation:${index}`, group: "picture", text: `- -> ${option}${action}`,
      part: { role: "relation", kind: relation.kind, from: relation.from, to: relation.to, target, ...(relation.label ? { label: relation.label } : {}), ...(at < 0 ? {} : { option: { number: at + 1, ...(mark ? { mark } : {}) } }), depth: depth + 1 } }
  }
  const roots = inside(undefined)
  return [...[...roots.filter(part => acts.has(part.id)), ...roots.filter(part => !acts.has(part.id))].flatMap(part => walk(part, 0)),
    ...scene.limits.map((text, index): BriefNode => ({ id: `picture:limit:${index}`, group: "picture", text: `✕ ${text}`, part: { role: "limit", text } }))]
}

/** Record state kept apart from authority, from the canonical record only: the record's own status, the recommended
 * option, whether an option was recorded (and that recording one is not proof it was carried out), and, once closed
 * without a recorded option, that the outcome is not verified. Options are numbered in the request's order. */
export const authorityStrip = (item: DeskItem) => {
  const record = item.record
  if (!record) return
  const number = (id?: string | null) => record.options.findIndex(option => option.id === id) + 1
  const chosen = number(record.answer?.choice_id)
  const recommended = number(record.recommendation)
  const closed = record.status === "resolved" || record.status === "withdrawn"
  return [
    ({ open: "OPEN request", snoozed: "SNOOZED request", decided: "ANSWERED", answered: "ANSWERED", resolved: "RECORD CLOSED", withdrawn: "WITHDRAWN record" } as const)[record.status] ?? record.status.toUpperCase(),
    ...(recommended && recommended !== chosen ? [`◇ option ${recommended} recommended`] : []),
    ...(chosen ? [`✓ option ${chosen} = recorded choice, execution unverified`]
      : record.options.length ? [record.answer?.text?.trim() ? "answered in words, no option chosen" : "no option chosen"] : []),
    ...(closed && !chosen ? ["outcome unverified"] : []),
  ]
}

export type BriefSemantics = {
  /** Host-qualified item identity and the revision this brief was prepared for. */
  item: { key: string; host?: string; revision: string; title: string }
  asOf?: number
  nodes: BriefNode[]
}

const ORDER: BriefNodeGroup[] = ["item", "authority", "question", "row", "picture", "option", "risk", "evidence", "unknown", "state"]

/** The brief's meaning in order: what it is about, its record and authority state, the question, each option with its consequence, risks, evidence,
 * what is not known, and the current state with its time. Numbered request items come right after the question, and
 * the picture before the options, as the card draws them. Values come from the canonical record and the brief only. */
export const briefSemantics = (item: DeskItem, result: BriefResult, options: { host?: string; asOf?: number; documents?: ConversationDocument[] } = {}): BriefSemantics => {
  const record = item.record
  const chosen = record?.answer?.choice_id
  const choices = record?.options.length
    ? record.options.map(option => ({ option, brief: result.choices.find(entry => entry.id === option.id) }))
    : []
  const strip = authorityStrip(item)
  const nodes: BriefNode[] = [
    { id: "item", group: "item", text: item.title },
    ...(strip ? [{ id: "authority", group: "authority" as const, text: `[${strip.join(" · ")}]`, strip }] : []),
    { id: "question", group: "question", text: result.question || item.title },
    // Numbered items the request lists (D1..D7), in its order with its ids, one node each, never merged. Only values
    // quoted in the request are shown (briefItems, as on the desktop card); the rest reads as not given.
    ...briefItems(result, item, options.documents).map((row): BriefNode => ({ id: `row:${row.id}`, group: "row", row,
      text: `${row.id} ${row.question || MISSING} → ${row.recommended || MISSING}${row.alternatives.filter(Boolean).length ? ` (or ${row.alternatives.filter(Boolean).join(", ")})` : ""}` })),
    ...choices.map(({ option, brief }): BriefNode => ({
      id: `option:${option.id}`, group: "option",
      text: [option.label, brief?.outcome].filter(Boolean).join(": "),
      ...(chosen === option.id ? { mark: "chosen" as const } : record?.recommendation === option.id ? { mark: "recommended" as const } : {}),
    })),
    ...pictureNodes(result, item, options.documents),
    ...choices.flatMap(({ option, brief }) => brief?.note ? [{ id: `risk:${option.id}`, group: "risk" as const, text: `${option.label}: ${brief.note}` }] : []),
    ...(result.ifWait ? [{ id: "risk:wait", group: "risk" as const, text: `If you wait: ${result.ifWait}` }] : []),
    ...result.facts.map((fact, index): BriefNode => ({ id: `evidence:${index}`, group: "evidence", text: fact.text, refs: fact.refs })),
    ...result.gaps.map((gap, index): BriefNode => ({ id: `unknown:${index}`, group: "unknown", text: gap })),
    // As of: when this brief was prepared (its job's start), stated only when known.
    { id: "state", group: "state", text: [record && `${record.status}${chosen ? ` · answered ${record.options.find(option => option.id === chosen)?.label ?? chosen}` : ""}`,
      `revision ${item.revision}`, options.asOf ? `as of ${new Date(options.asOf).toISOString().slice(5, 16).replace("T", " ")}Z` : "as of unknown"].filter(Boolean).join(" · ") },
  ]
  return { item: { key: item.key, ...(options.host ? { host: options.host } : {}), revision: item.revision, title: item.title },
    ...(options.asOf ? { asOf: options.asOf } : {}), nodes: nodes.sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group)) }
}

// G2: 576x288 px, one colour. At 18 px monospace that is 9 lines of 48 characters; the top line names the page and the
// bottom line is the pager, so a page holds 7 lines of content.
export const HUD = { width: 576, height: 288, columns: 48, rows: 9, maxPages: 6 } as const

const PREFIX: Record<BriefNodeGroup, string> = { item: "", authority: "", question: "? ", row: "", picture: "", option: "· ", risk: "! ", evidence: "✓ ", unknown: "~ ", state: "" }

export type HudLine = { node: string; text: string }
export type HudPage = { index: number; total: number; title: string; lines: HudLine[]; pager: string }

const wrap = (text: string, width: number, indent: string) => {
  const room = width - indent.length
  const words = text.replace(/\s+/g, " ").trim().split(" ").flatMap(word => word.length > room ? word.match(new RegExp(`.{1,${room}}`, "g")) ?? [word] : [word])
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    if (!line) { line = (lines.length ? indent : "") + word; continue }
    if (line.length + 1 + word.length > width) { lines.push(line); line = indent + word } else line += ` ${word}`
  }
  if (line) lines.push(line)
  return lines
}

/** The HUD pages: the same nodes in the same order, wrapped to the glasses' columns and cut into pages at node
 * boundaries when they fit (a node longer than a page continues on the next). The item and state go on the first
 * page's title and the pager, never dropped. When the brief needs more than `maxPages`, the last page says where the
 * rest is instead of shrinking text. Deterministic: the same brief always gives the same pages. */
export const hudPages = (semantics: BriefSemantics, limits = HUD): HudPage[] => {
  const body = limits.rows - 2
  const content = semantics.nodes.filter(node => node.group !== "item" && node.group !== "state")
  const lines = content.flatMap(node => {
    const mark = node.mark === "recommended" ? " (rec)" : node.mark === "chosen" ? " (chosen)" : ""
    // Scene parts keep their nesting as indentation, so containment survives without colour or boxes.
    const pad = " ".repeat(node.part && "depth" in node.part ? Math.min(node.part.depth, 4) * 2 : 0)
    return wrap(`${PREFIX[node.group]}${node.text}${mark}`, limits.columns - pad.length, "  ").map(text => ({ node: node.id, text: pad + text }))
  })
  const pages: HudLine[][] = []
  let page: HudLine[] = []
  let index = 0
  while (index < lines.length) {
    const node = lines[index]!.node
    const run = lines.slice(index).findIndex(line => line.node !== node)
    const size = run < 0 ? lines.length - index : run
    // Start a new page for a node that does not fit what is left, unless it would not fit a whole page either.
    if (page.length && page.length + size > body && size <= body) { pages.push(page); page = [] }
    for (const line of lines.slice(index, index + size)) {
      if (page.length === body) { pages.push(page); page = [] }
      page.push(line)
    }
    index += size
  }
  if (page.length || !pages.length) pages.push(page)
  const where = `More on the desk: ${semantics.item.host ? `${semantics.item.host}~` : ""}${semantics.item.key}`
  const kept = pages.length > limits.maxPages
    ? [...pages.slice(0, limits.maxPages - 1), [...wrap(where, limits.columns, "  ").map(text => ({ node: "more", text }))]]
    : pages
  const state = semantics.nodes.find(node => node.group === "state")?.text ?? ""
  const title = clip(semantics.nodes.find(node => node.group === "item")?.text ?? semantics.item.title, limits.columns)
  return kept.map((lines, position) => ({ index: position + 1, total: kept.length, title, lines,
    pager: clip(`${position + 1}/${kept.length} · ${state}`, limits.columns) }))
}

const clip = (text: string, width: number) => text.length > width ? `${text.slice(0, width - 1)}…` : text
