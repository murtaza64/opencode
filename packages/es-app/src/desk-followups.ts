/* What the Front desk is waiting on: the questions its conversation sent owners by es mail, and whether each
 * was delivered and answered. Read-only, from each editspace's mail timeline for the desk session (the dashboard
 * selects mail by its sender session); nothing here sends, acknowledges or marks anything read. */
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
  intents: { id: string; mode?: string; source_scope?: string; source_capability?: string; fallback?: string; outputs?: string[]; not_granted?: string[]
    owner?: { host?: string; editspace?: string; lane?: string; session?: string; role?: string }; evidence?: string; state?: string; state_at?: number; next?: string }[]
  deliverables: { id: string; intent?: string; label: string; ref?: string; read_back?: boolean; read_back_at?: number; evidence?: string }[]
}

export const readCases = async () => {
  const response = await fetch("/es/api/frontdesk/cases", { credentials: "include" })
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
    ...item.intents.map(part => `  - ${part.id} [${part.state ?? "requested"}] owner ${owner(part)}${part.source_scope ? ` · source: ${part.source_scope}` : ""}${part.fallback ? ` · fallback: ${part.fallback}` : ""}${part.not_granted?.length ? ` · not granted: ${part.not_granted.join("; ")}` : ""}${part.next ? ` · next: ${part.next}` : ""}`),
    ...item.deliverables.map(deliverable => `  - deliverable ${deliverable.label}${deliverable.ref ? ` ${deliverable.ref}` : ""} · ${deliverable.read_back ? "read back" : "not read back yet"}`),
  ]),
] : []

/** A part's label for people: its id with separators as spaces ("diff-streams-discovery" → "Diff streams discovery"). */
export const partLabel = (id: string) => { const words = id.replace(/[-_.]+/g, " ").trim(); return words.charAt(0).toUpperCase() + words.slice(1) }

/** One row of the desk's progress strip. `at` is when the part last changed state (or the mail's time); absent, the
 * row's age is unknown. `detail` carries owners and ids, shown only on request. */
export type ProgressRow = { key: string; group: "needs" | "progress" | "unknown" | "result"; label: string; context?: string; status: string; at?: number; link?: { label: string; href: string }; detail: string[] }

const OPEN = new Set(["requested", "routed", "acknowledged", "working"])
const DONE = new Set(["delivered", "done"])

/** The strip's rows: what needs the human, what is in progress, parts in a state the desk does not recognise, then
 * every result, newest first. Withdrawn parts leave the strip; nothing older is dropped. A case's own `updated` time
 * is never a part's age: it moves whenever any part or note changes. */
export const progressRows = (cases: DeskCase[], items: FollowUp[]): ProgressRow[] => {
  const rows: ProgressRow[] = []
  for (const item of cases) {
    const title = item.title || partLabel(item.case_id)
    for (const part of item.intents) {
      const state = part.state ?? "requested"
      if (state === "withdrawn") continue
      const owner = [part.owner?.lane, part.owner?.editspace, part.owner?.host].filter(Boolean).join(" · ")
      const detail = [`case ${item.case_id}`, `part ${part.id}`, ...(owner ? [`owner ${owner}`] : []), ...(part.owner?.session ? [part.owner.session] : []), ...(part.next ? [`next: ${part.next}`] : [])]
      const deliverable = item.deliverables.find(entry => entry.intent === part.id && entry.read_back && entry.ref && /^https?:\/\//.test(entry.ref))
      const group = state === "waiting" ? "needs" : DONE.has(state) ? "result" : OPEN.has(state) ? "progress" : "unknown"
      rows.push({ key: `${item.case_id}/${part.id}`, group, label: partLabel(part.id), context: title, ...(part.state_at ? { at: part.state_at } : {}),
        status: group === "needs" ? part.next || "Waiting for you" : group === "result" ? "Delivered" : group === "unknown" ? `Unknown state: ${state}` : part.next || "In progress",
        ...(deliverable ? { link: { label: deliverable.label, href: deliverable.ref! } } : {}), detail })
    }
  }
  for (const item of items) rows.push({
    key: `${item.editspace}:${item.id}`, group: item.answer ? "result" : "progress", label: item.text.slice(0, 80), at: item.answer?.at ?? item.asked,
    status: item.answer ? `Answered by ${item.owner}` : `Asked ${item.owner}${item.delivery === "failed" ? " · not delivered" : item.delivery === "unknown" ? " · delivery unknown" : ""}`,
    detail: [`${item.editspace}:${item.id}`, ...(item.answer ? [`answer ${item.editspace}:${item.answer.id}`] : [])],
  })
  const order = { needs: 0, progress: 1, unknown: 2, result: 3 }
  // Newest first within a group; rows of unknown age after those with one.
  return rows.sort((a, b) => order[a.group] - order[b.group] || (b.at ?? -1) - (a.at ?? -1))
}
