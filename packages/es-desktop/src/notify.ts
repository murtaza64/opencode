/* Which OS notifications one host's actionable items warrant, given what this device already
 * posted. Pure: callers read the host and post/close notifications. Every source (event nudge,
 * resume, a later push channel) runs the same reconcile, so duplicates collapse into one
 * replace keyed by `tag`. `notify.fixture.json` is shared with the Android port. */

export type AttentionItem = {
  id: string
  editspace: string
  status: string
  revision: number
  content_revision?: number
  title: string
  delivery_state?: string
  answer?: { answered_at?: number } | null
}

export type RequestItem = { id: string; kind: string; editspace: string; session: string; title: string }

export type NotifyKind = "decision" | "stalled" | "delivery-blocked" | "permission" | "question"

export type Notice = { kind: NotifyKind; editspace: string; id: string; title: string; revision?: number; session?: string }

export type NotifyAction = ({ op: "post" | "update"; tag: string } & Notice) | { op: "cancel"; tag: string }

/** Tag -> stamp of what was last posted. */
export type Ledger = Record<string, number>

const STALLED_MS = 4 * 60 * 60 * 1000

export const reconcile = (input: {
  origin: string
  attention: AttentionItem[]
  requests: RequestItem[]
  ledger: Ledger
  now: number
}) => {
  const current = new Map<string, { stamp: number; notice: Notice }>()
  const add = (tag: string, stamp: number, notice: Notice) => current.set(tag, { stamp, notice })

  for (const record of input.attention) {
    const base = `${input.origin}|${record.editspace}|att:${record.id}`
    const ref = { editspace: record.editspace, id: record.id, revision: record.revision, title: record.title }
    // An answer that cannot reach its agent needs the human again.
    if (record.delivery_state === "blocked" && (record.status === "answered" || record.status === "decided"))
      add(`${base}:blocked`, 0, { kind: "delivery-blocked", ...ref })
    // Answered but unresolved for 4 h: alert once; resolving clears it.
    const answeredAt = record.answer?.answered_at
    if (record.status === "answered" && answeredAt && input.now - answeredAt > STALLED_MS)
      add(`${base}:stalled`, 0, { kind: "stalled", ...ref })
    // Delivery and snooze bookkeeping bump `revision` without changing what the human must
    // decide, so only entering open or a content change alerts.
    if (record.status === "open") add(base, record.content_revision ?? record.revision, { kind: "decision", ...ref })
  }
  for (const request of input.requests) {
    // Idle/completion entries are not actionable and never notify.
    if (request.kind !== "permission" && request.kind !== "question") continue
    add(`${input.origin}|${request.editspace}|req:${request.id}`, 0, {
      kind: request.kind,
      editspace: request.editspace,
      id: request.id,
      session: request.session,
      title: request.title,
    })
  }

  const own = (tag: string) => tag.startsWith(`${input.origin}|`)
  const actions: NotifyAction[] = [
    ...[...current.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .filter(([tag, entry]) => !(tag in input.ledger) || input.ledger[tag] < entry.stamp)
      .map(([tag, entry]): NotifyAction => ({ op: tag in input.ledger ? "update" : "post", tag, ...entry.notice })),
    // Reconciling one host never touches another host's notifications.
    ...Object.keys(input.ledger)
      .sort()
      .filter((tag) => own(tag) && !current.has(tag))
      .map((tag): NotifyAction => ({ op: "cancel", tag })),
  ]
  const ledger: Ledger = {
    ...Object.fromEntries(Object.entries(input.ledger).filter(([tag]) => !own(tag))),
    ...Object.fromEntries([...current.entries()].map(([tag, entry]) => [tag, entry.stamp])),
  }
  return { actions, ledger }
}
