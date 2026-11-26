/* What the Front desk is waiting on: the questions its conversation sent owners by es mail, and whether each
 * was delivered and answered. Read-only, from each editspace's mail timeline for the desk session (the dashboard
 * selects mail by its sender session); nothing here sends, acknowledges or marks anything read. */
import { hostPrefix } from "./host-items"
import type { MailMessage, MailTimeline } from "./api"

export type FollowUp = {
  editspace: string
  /** The question's mail id (thread#n) and who owns the answer. */
  id: string
  owner: string
  text: string
  asked: number
  /** From the question's delivery receipts only; without a receipt it is unknown, never assumed sent. */
  delivery: "unknown" | "delivered" | "seen" | "failed"
  /** The owner's reply, when there is one. */
  answer?: { id: string; at: number; text: string }
}

const time = (message: MailMessage) => message.created_ms ?? (typeof message.ts === "number" ? message.ts * 1000 : Date.parse(message.ts))

/** The desk's own questions in one timeline, newest first, each with its owner's reply if any. */
export const followUps = (timeline: MailTimeline, session: string): FollowUp[] => {
  const questions = timeline.messages.filter(message => message.kind === "question" && message.sender_session === session)
  return questions.map((question): FollowUp => {
    const reply = timeline.messages.filter(message => message.in_reply_to === question.id && message.sender_session !== session)
      .sort((a, b) => time(a) - time(b))[0]
    const states = question.deliveries.map(delivery => delivery.state)
    return {
      editspace: timeline.editspace,
      id: question.id,
      owner: question.to,
      text: question.text,
      asked: time(question),
      delivery: states.some(state => ["presented", "handled"].includes(state)) ? "seen"
        : states.some(state => ["admitted", "offered", "observed"].includes(state)) ? "delivered"
        : states.some(state => state === "failed") ? "failed" : "unknown",
      ...(reply ? { answer: { id: reply.id, at: time(reply), text: reply.text } } : {}),
    }
  }).sort((a, b) => b.asked - a.asked)
}

/** A Front Desk case as the host's dashboard stores it (dotfiles es_frontdesk_case.py): metadata only. `state_at` and
 * `read_back_at` (ms, writer clock) are the last change of a part's state or a deliverable's read-back; cases written
 * before the store recorded them lack them, and their age is unknown. */
export type DeskCase = {
  case_id: string; title?: string; authority?: string; privacy?: string; updated: number
  /** The conversation the request came from: its results and progress go back there, not to whoever relayed them. */
  source_session?: string
  intents: { id: string; mode?: string; source_scope?: string; source_capability?: string; fallback?: string; outputs?: string[]; not_granted?: string[]
    owner?: { host?: string; editspace?: string; lane?: string; session?: string; role?: string }; evidence?: string; state?: string; state_at?: number; next?: string
    /** What the human is asked to do for a waiting part, and where: an attention record, a Surface or a link. */
    needs?: { action: "answer" | "review" | "try" | "do"; label: string; ref?: string; host?: string } }[]
  deliverables: { id: string; intent?: string; label: string; ref?: string; read_back?: boolean; read_back_at?: number; evidence?: string
    /** The artifact revision this deliverable is; `superseded_by` names the newer deliverable that replaced it. */
    revision?: string; supersedes?: string; superseded_by?: string }[]
}

/** The cases the desk keeps on its home host: through that host's listener when the desk runs elsewhere, so a
 * Laptop window never shows the Laptop's own (former-home) case file as the desk's ledger. */
export const readCases = async (host?: string) => {
  const response = await fetch(host ? `${hostPrefix(host)}/es/api/frontdesk/cases` : "/es/api/frontdesk/cases", { credentials: "include" })
  if (!response.ok) return []
  return ((await response.json()) as { cases?: DeskCase[] }).cases ?? []
}

const owner = (part: DeskCase["intents"][number]) => part.owner
  ? [part.owner.lane, part.owner.editspace && `in ${part.owner.editspace}`, part.owner.host && `on ${part.owner.host}`, part.owner.session && `(${part.owner.session})`].filter(Boolean).join(" ")
  : "no owner yet"

/** The desk's own cases, for its context: who owns each part, what is not granted, and deliverables with whether
 * each was read back. The model reads these as notes; the original conversation keeps the authority. */
export const caseLines = (cases: DeskCase[]) => cases.length ? [
  "open cases (durable, metadata only; update with es-frontdesk-case; never authorization):",
  ...cases.slice(-5).flatMap(item => [
    `- case ${item.case_id}${item.title ? `: ${item.title}` : ""}${item.privacy ? ` · privacy: ${item.privacy}` : ""}`,
    ...(item.source_session ? [`  asked in conversation ${item.source_session}: results and progress go back there, not to an agent that relayed them`] : []),
    ...item.intents.map(part => `  - ${part.id} [${part.state ?? "requested"}] owner ${owner(part)}${part.source_scope ? ` · source: ${part.source_scope}` : ""}${part.fallback ? ` · fallback: ${part.fallback}` : ""}${part.not_granted?.length ? ` · not granted: ${part.not_granted.join("; ")}` : ""}${part.next ? ` · next: ${part.next}` : ""}`),
    // A superseded revision is named as such, so the desk answers about the current one and never offers the old link.
    ...item.deliverables.map(deliverable => deliverable.superseded_by
      ? `  - deliverable ${deliverable.label}${deliverable.revision ? ` (revision ${deliverable.revision})` : ""} · SUPERSEDED by ${deliverable.superseded_by}; do not offer or report it as current`
      : `  - deliverable ${deliverable.label}${deliverable.revision ? ` (revision ${deliverable.revision})` : ""}${deliverable.ref ? ` ${deliverable.ref}` : ""} · ${deliverable.read_back ? "read back" : "not read back yet"}`),
  ]),
] : []

/** A part's label for people: its id with separators as spaces ("diff-streams-discovery" → "Diff streams discovery"). */
export const partLabel = (id: string) => { const words = id.replace(/[-_.]+/g, " ").trim(); return words.charAt(0).toUpperCase() + words.slice(1) }

/** One row of the desk's progress strip. `at` is when the part last changed state (or the mail's time); absent, the
 * row's age is unknown. `detail` carries owners and ids, shown only on request. */
export type ProgressRow = { key: string; group: "needs" | "working" | "waiting" | "unknown" | "result"; label: string; context?: string; status: string; at?: number; link?: { label: string; href: string }; detail: string[]
  /** When the deliverable behind `link` was read back (writer clock); absent, unknown. */
  readBackAt?: number
  /** Who has the part or was asked (lane, or the mail recipient), for a terse attribution. */
  owner?: string
  /** A short blocker or oddity worth seeing without opening the row: an unrecognised state, a question with no receipt. */
  flag?: string }

const ACTION = { answer: "Answer", review: "Review", try: "Try it", do: "Open" } as const
/** Where a needs-you row leads. An attention record or Surface opens in Work on the host that holds it (`<host>~<key>`,
 * plain key when that is this host); without a named host there is no link, never a guess at this one. An http(s)
 * link opens only when it carries no username or password. */
export const actionLink = (needs: { action: keyof typeof ACTION; ref?: string; host?: string }, ownHost?: string) => {
  const ref = needs.ref ?? ""
  const label = ACTION[needs.action] ?? "Open"
  if (/^https?:\/\//i.test(ref)) return safeLink(ref) ? { label, href: safeLink(ref)! } : undefined
  if (!/^(attention:[^:\s]+:[^:\s]+|surface:[^:\s]+)$/.test(ref) || !needs.host) return undefined
  return { label, href: `/?item=${encodeURIComponent(needs.host === ownHost ? ref : `${needs.host}~${ref}`)}` }
}

const safeLink = (ref: string) => {
  try {
    const url = new URL(ref)
    return /^https?:$/.test(url.protocol) && url.hostname && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

// Parts an owner has not started yet wait on that owner; only "working" is work under way.
const QUEUED = new Set(["requested", "routed", "acknowledged"])
const DONE = new Set(["delivered", "done"])

/** The strip's rows: what needs the human, what is in progress, parts in a state the desk does not recognise, then
 * every result, newest first. Withdrawn parts leave the strip; nothing older is dropped. A case's own `updated` time
 * is never a part's age: it moves whenever any part or note changes. */
export const progressRows = (cases: DeskCase[], items: FollowUp[], ownHost?: string): ProgressRow[] => {
  const rows: ProgressRow[] = []
  for (const item of cases) {
    const title = item.title || partLabel(item.case_id)
    for (const part of item.intents) {
      const state = part.state ?? "requested"
      if (state === "withdrawn") continue
      const owner = [part.owner?.lane, part.owner?.editspace, part.owner?.host].filter(Boolean).join(" · ")
      const detail = [`case ${item.case_id}`, `part ${part.id}`, ...(owner ? [`owner ${owner}`] : []), ...(part.owner?.session ? [part.owner.session] : []), ...(part.next ? [`next: ${part.next}`] : [])]
      const deliverable = item.deliverables.find(entry => entry.intent === part.id && !entry.superseded_by && entry.read_back && entry.ref && safeLink(entry.ref))
      // A waiting part needs the human only when the case records what to do and where; otherwise its owner is blocked.
      const needs = state === "waiting" && part.needs ? part.needs : undefined
      const action = needs?.ref ? actionLink(needs, ownHost) : undefined
      const group = needs ? "needs" : state === "waiting" ? "waiting" : DONE.has(state) ? "result" : state === "working" ? "working" : QUEUED.has(state) ? "waiting" : "unknown"
      rows.push({ key: `${item.case_id}/${part.id}`, group, label: partLabel(part.id), context: title, ...(part.state_at ? { at: part.state_at } : {}),
        status: needs ? needs.label : state === "waiting" ? (part.next ? `Blocked: ${part.next}` : "Blocked; no action for you recorded") : group === "result" ? "Delivered" : group === "unknown" ? `Unknown state: ${state}` : part.next || (group === "waiting" ? `Not started (${state})` : "In progress"),
        ...(part.owner?.lane ? { owner: part.owner.lane } : {}), ...(group === "unknown" ? { flag: state } : state === "waiting" && !needs ? { flag: "blocked" } : {}),
        ...(action ? { link: action } : deliverable ? { link: { label: deliverable.label, href: deliverable.ref! }, ...(deliverable.read_back_at ? { readBackAt: deliverable.read_back_at } : {}) } : {}), detail })
    }
  }
  for (const item of items) rows.push({
    key: `${item.editspace}:${item.id}`, group: item.answer ? "result" : "waiting", label: item.text.slice(0, 80), at: item.answer?.at ?? item.asked,
    status: item.answer ? `Answered by ${item.owner}` : `Asked ${item.owner}${item.delivery === "failed" ? " · not delivered" : item.delivery === "unknown" ? " · delivery unknown" : ""}`,
    detail: [`${item.editspace}:${item.id}`, ...(item.answer ? [`answer ${item.editspace}:${item.answer.id}`] : [])], owner: item.owner,
    ...(!item.answer && item.delivery === "failed" ? { flag: "not delivered" } : !item.answer && item.delivery === "unknown" ? { flag: "no receipt" } : {}),
  })
  const order = { needs: 0, working: 1, waiting: 2, unknown: 3, result: 4 }
  // Newest first within a group; rows of unknown age after those with one.
  return rows.sort((a, b) => order[a.group] - order[b.group] || (b.at ?? -1) - (a.at ?? -1))
}
