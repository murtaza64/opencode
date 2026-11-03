/* On-surface comments (DD #519 M1): the store contract (`es-surface-comments/1`, remote-host-client #530), the host
 * adapter the reader overlay talks to, and the small pure rules for threads, placement and receipts. The overlay is
 * components/surface-comments.tsx; the in-frame anchor bridge is ../surface-bridge.ts. */

export type CommentRect = { x: number; y: number; w: number; h: number }
/** Where a comment points. At least one of `id`, `selector` or `rect` (document fractions); `hash` detects a changed target. */
export type CommentAnchor = { id?: string; selector?: string; hash?: string; rect?: CommentRect }
export type SurfaceComment = {
  comment_id: string
  surface_id: string
  revision: number
  anchor: CommentAnchor
  author: { role: string; name: string }
  body: string
  created_at: number
  parent_id: string | null
  state: string
  /** The owner-mail receipt: new comments batch for about two minutes per Surface, then go to its owner lane. */
  routing?: { state: "pending" | "routed" | "failed"; to?: string; message_id?: string; at?: number } | null
}
/** What Send sealed. A retry sends exactly this again (same id, same bytes), so the store can recognise it. */
export type SealedComment = { comment_id: string; revision: number; anchor: CommentAnchor; body: string; parent_id?: string }
export type SendResult = { ok: true; comment: SurfaceComment; duplicate: boolean } | { ok: false; error: string }
export type ReadResult = { comments: SurfaceComment[] } | { unavailable: string }

/** What the overlay needs from wherever comments live. `esSurfaceHost` is the es dashboard store; another host
 * (Workbench, MCR) supplies its own adapter with the same two calls. */
export type CommentHost = {
  read: () => Promise<ReadResult>
  send: (comment: SealedComment) => Promise<SendResult>
}

export const commentsPath = (surface: string, prefix = "") => `${prefix}/es/api/surfaces/${encodeURIComponent(surface)}/comments`

/** A client id the store accepts (`[A-Za-z0-9_-]{8,64}`), minted once per comment at Send and reused by every retry. */
export const mintCommentId = () => crypto.randomUUID().replaceAll("-", "")

export const MAX_BODY = 4000

/** The es dashboard's comment store for one Surface: this host's (`prefix` "") or another Work host's
 * (`/hosts/<id>`, with that host's operator cookie). A missing operator session is set up once, then the same
 * request is sent again. */
export const esSurfaceHost = (surface: string, prefix = "", send: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init)): CommentHost => {
  const path = commentsPath(surface, prefix)
  return {
    read: async () => {
      const response = await send(path, { credentials: "include", cache: "no-store" }).catch(() => undefined)
      if (!response) return { unavailable: "Comments are unreachable right now." }
      if (response.status === 404 || response.status === 501 || !response.headers.get("content-type")?.includes("application/json"))
        return { unavailable: "This host does not store comments yet." }
      if (!response.ok) return { unavailable: `Comments unavailable (HTTP ${response.status}).` }
      const body = (await response.json()) as { comments?: SurfaceComment[] }
      return { comments: Array.isArray(body.comments) ? body.comments : [] }
    },
    send: async (comment) => {
      const post = () => send(path, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: JSON.stringify(comment),
      }).catch(() => undefined)
      const first = await post()
      // Only the dashboard's own refusal (JSON) asks for an operator session; a listener refusal (plain text) does not.
      const operator = (first?.status === 401 || first?.status === 403) && first.headers.get("content-type")?.includes("application/json")
      const response = operator ? await send(`${prefix}/es/api/attention/session`, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: "{}" })
        .then(async (session) => { await session.body?.cancel(); return post() }, () => undefined) : first
      if (!response) return { ok: false, error: "Not sent: the host did not answer." }
      if (response.ok) {
        const body = (await response.json()) as { comment: SurfaceComment; receipt?: { duplicate?: boolean } }
        return { ok: true, comment: body.comment, duplicate: !!body.receipt?.duplicate }
      }
      const reason = await response.json().then((body: { error?: unknown }) => (typeof body.error === "string" ? body.error : undefined), () => undefined)
      return { ok: false, error: sendError(response.status, reason) }
    },
  }
}

const sendError = (status: number, reason: string | undefined) => {
  if (status === 401 || status === 403) return "Not sent: the operator connection is unavailable."
  if (status === 409) return reason?.includes("revision") ? "Not sent: this revision is not published on its host." : "Not sent: this comment id was already used for different text."
  if (status === 404) return "Not sent: the Surface or the comment being replied to is gone."
  if (status === 413) return `Not sent: comments are limited to ${MAX_BODY} characters.`
  return reason ? `Not sent: ${reason}.` : `Not sent (HTTP ${status}).`
}

export type Thread = { root: SurfaceComment; replies: SurfaceComment[] }

/** Roots with their replies, oldest first. A reply whose parent is not in the list becomes its own root, so nothing
 * the store returned is hidden. */
export const threads = (comments: SurfaceComment[]): Thread[] => {
  const ids = new Set(comments.map((comment) => comment.comment_id))
  const sorted = comments.toSorted((a, b) => a.created_at - b.created_at)
  return sorted
    .filter((comment) => !comment.parent_id || !ids.has(comment.parent_id))
    .map((root) => ({ root, replies: sorted.filter((comment) => comment.parent_id === root.comment_id) }))
}

/** Where the bridge found an anchor in the frame on screen. */
export type AnchorState = "shown" | "changed" | "hidden" | "missing"

/** Whether a thread gets a marker on the revision on screen, or why not. Comments never move to another element:
 * another revision, a vanished or hidden target means no marker, with the reason listed instead. */
export const placement = (root: SurfaceComment, revision: number, found: AnchorState | undefined) => {
  if (root.revision !== revision) return "other-revision" as const
  return found ?? ("locating" as const)
}

export const placementLabel = (state: ReturnType<typeof placement>, revision: number) =>
  ({
    "other-revision": `on revision ${revision}`,
    missing: "its target is gone",
    hidden: "its target is hidden",
    changed: "its target changed since",
    shown: "",
    locating: "locating",
  })[state]

/** Receipt wording from the store's own fields only: stored is not read, routed is not acted on. */
export const receiptLabel = (comment: SurfaceComment) => {
  const routing = comment.routing
  if (!routing || routing.state === "pending") return "Saved · goes to the owner within ~2 min"
  if (routing.state === "routed") return `Saved · sent to ${routing.to ?? "the owner"} · not a read receipt`
  return "Saved · not routed to the owner"
}

export const initialOf = (name: string | undefined) => (name?.trim()[0] ?? "?").toUpperCase()
