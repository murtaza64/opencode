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

/** Open questions first, then answers from the last day; older answered ones fold into a count. */
export const visibleFollowUps = (items: FollowUp[], now: number) => {
  const recent = (item: FollowUp) => !!item.answer && now - item.answer.at < 86_400_000
  return { shown: [...items.filter(item => !item.answer), ...items.filter(recent)], earlier: items.filter(item => item.answer && !recent(item)) }
}

/** A Front Desk case as the host's dashboard stores it (dotfiles es_frontdesk_case.py): metadata only. */
export type DeskCase = {
  case_id: string; title?: string; authority?: string; privacy?: string; updated: number
  intents: { id: string; mode?: string; source_scope?: string; source_capability?: string; fallback?: string; outputs?: string[]; not_granted?: string[]
    owner?: { host?: string; editspace?: string; lane?: string; session?: string; role?: string }; evidence?: string; state?: string; next?: string }[]
  deliverables: { id: string; intent?: string; label: string; ref?: string; read_back?: boolean; evidence?: string }[]
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
