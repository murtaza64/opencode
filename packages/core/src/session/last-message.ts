export * as SessionLastMessage from "./last-message"

import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { SessionV1 } from "../v1/session"
import { MessageTable, PartTable, SessionTable } from "./sql"

/**
 * The latest visible human input or finalized assistant text of one Session, projected for session lists.
 *
 * The `session.last_message` column holds:
 * - `null`: unknown (sessions from before this column, a staged revert, or a bounded recompute that found nothing);
 * - `{ type: "none" }`: the Session has had no qualifying message since it was created;
 * - `{ type: "message", ... }`: the latest qualifying message, with its real time.
 *
 * Qualifying text is non-empty, not synthetic and not ignored. User text counts only when typed (no editspace mail
 * source); assistant text counts once finalized (`time.end`) and never from compaction summaries. Tool, reasoning and
 * file parts never count, so a tool call newer than the message leaves it unchanged.
 */
export const EXCERPT = 200
/**
 * Credential-shaped text, replaced before excerpting so list rows and phones never show token-like strings. The full
 * message is unchanged; this is list hygiene, not a secret scanner.
 */
const CREDENTIAL = new RegExp(
  [
    String.raw`\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}`,
    String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}`,
    String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`,
    String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`,
    String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
    String.raw`\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}`,
    // Long random-looking runs: digits plus non-hex letters, so paths, words and git SHAs stay readable.
    String.raw`\b(?=[A-Za-z_-]*[0-9])(?=[0-9a-fA-F_-]*[g-zG-Z])[A-Za-z0-9+_-]{40,}={0,2}`,
  ].join("|"),
  "g",
)
export const REDACTED = "[redacted]"

/** Messages inspected when the projected message disappears; beyond this the value becomes unknown. */
export const RECOMPUTE = 50

export const Source = Schema.Union([
  Schema.Struct({ type: Schema.Literal("human") }),
  Schema.Struct({
    type: Schema.Literal("agent"),
    agent: Schema.String,
    providerID: Schema.String,
    modelID: Schema.String,
  }),
]).annotate({ identifier: "SessionLastMessageSource" })

export const Message = Schema.Struct({
  type: Schema.Literal("message"),
  /** Opaque message identity; not an ordering key. */
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  source: Source,
  /** User: message creation time. Assistant: when the text finished. */
  time: Schema.Number,
  excerpt: Schema.String,
  truncated: Schema.Boolean,
}).annotate({ identifier: "SessionLastMessageItem" })

export const Info = Schema.Union([Schema.Struct({ type: Schema.Literal("none") }), Message]).annotate({
  identifier: "SessionLastMessage",
})
export type Info = Schema.Schema.Type<typeof Info>

/** Stored form: the public value plus the part it came from, so part updates and removals can find it. */
type StoredMessage = Schema.Schema.Type<typeof Message> & { partID: string }
export type Stored = { type: "none" } | StoredMessage

export const NONE: Stored = { type: "none" }

type Db = Database.Interface["db"]
// Row JSON omits identity fields; the omission is distributed so role and part type still narrow.
type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type MessageData = Without<SessionV1.Info, "id" | "sessionID">
type PartData = Without<SessionV1.Part, "id" | "sessionID" | "messageID">

export function toInfo(stored: Stored): Info {
  if (stored.type === "none") return stored
  const { partID: _, ...info } = stored
  return info
}

/** The value a text part contributes, or undefined when it does not qualify. */
export function candidate(
  message: { id: string; time_created: number; data: Omit<SessionV1.Info, "id" | "sessionID"> },
  part: { id: string; data: Omit<SessionV1.Part, "id" | "sessionID" | "messageID"> },
): StoredMessage | undefined {
  const data = message.data as MessageData
  const textPart = part.data as PartData
  if (textPart.type !== "text" || textPart.synthetic || textPart.ignored) return
  const text = textPart.text.replace(/\s+/g, " ").trim().replace(CREDENTIAL, REDACTED)
  if (!text) return
  const chars = Array.from(text)
  const base = {
    type: "message" as const,
    id: message.id,
    partID: part.id,
    excerpt: chars.slice(0, EXCERPT).join(""),
    truncated: chars.length > EXCERPT,
  }
  if (data.role === "user") {
    if (data.source) return
    return { ...base, role: "user", source: { type: "human" }, time: message.time_created }
  }
  if (data.summary || textPart.time?.end === undefined) return
  return {
    ...base,
    role: "assistant",
    source: { type: "agent", agent: data.agent, providerID: data.providerID, modelID: data.modelID },
    time: textPart.time.end,
  }
}

/** Fold one updated text part into the projection; call after the part row is written. */
export const observe = Effect.fnUntraced(function* (db: Db, sessionID: string, messageID: string, partID: string) {
  const session = yield* db
    .select({ revert: SessionTable.revert, last: SessionTable.last_message })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID as never))
    .get()
    .pipe(Effect.orDie)
  // Staged revert hides messages; the value stays unknown until the revert is cleared or committed.
  if (!session || session.revert) return
  const message = yield* db
    .select({ id: MessageTable.id, time_created: MessageTable.time_created, data: MessageTable.data })
    .from(MessageTable)
    .where(and(eq(MessageTable.id, messageID as never), eq(MessageTable.session_id, sessionID as never)))
    .get()
    .pipe(Effect.orDie)
  const part = yield* db
    .select({ id: PartTable.id, data: PartTable.data })
    .from(PartTable)
    .where(eq(PartTable.id, partID as never))
    .get()
    .pipe(Effect.orDie)
  if (!message || !part) return
  const current = session.last
  // An unknown value cannot tell whether this part is the latest (it may be a late update of an old message), so it
  // is rebuilt from the newest messages instead.
  if (!current) return yield* recompute(db, sessionID)
  const next = candidate(message, part)
  if (!next) {
    if (current?.type === "message" && current.partID === partID) yield* recompute(db, sessionID)
    return
  }
  if (current?.type === "message" && current.partID !== partID && current.time > next.time) return
  yield* write(db, sessionID, next)
})

/** Re-check the projected message after its metadata changed, e.g. it gained a mail source or became a summary. */
export const messageChanged = Effect.fnUntraced(function* (db: Db, sessionID: string, messageID: string) {
  const current = yield* read(db, sessionID)
  if (current?.type !== "message" || current.id !== messageID) return
  yield* observe(db, sessionID, messageID, current.partID)
})

/** Recompute when the projected message or part may have gone; leaves other values alone. */
export const removed = Effect.fnUntraced(function* (
  db: Db,
  sessionID: string,
  target: { messageID: string } | { partID: string },
) {
  const current = yield* read(db, sessionID)
  if (current?.type !== "message") return
  if ("messageID" in target ? current.id !== target.messageID : current.partID !== target.partID) return
  yield* recompute(db, sessionID)
})

export const unknown = (db: Db, sessionID: string) => write(db, sessionID, null)

/** Rebuild from the latest RECOMPUTE messages only; never scans full history. */
export const recompute = Effect.fnUntraced(function* (db: Db, sessionID: string) {
  const messages = yield* db
    .select({ id: MessageTable.id, time_created: MessageTable.time_created, data: MessageTable.data })
    .from(MessageTable)
    .where(eq(MessageTable.session_id, sessionID as never))
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(RECOMPUTE)
    .all()
    .pipe(Effect.orDie)
  const parts = messages.length
    ? yield* db
        .select({ id: PartTable.id, message_id: PartTable.message_id, data: PartTable.data })
        .from(PartTable)
        .where(
          and(
            inArray(
              PartTable.message_id,
              messages.map((message) => message.id),
            ),
            sql`json_extract(${PartTable.data}, '$.type') = 'text'`,
          ),
        )
        .all()
        .pipe(Effect.orDie)
    : []
  const byID = new Map(messages.map((message) => [message.id, message]))
  const best = parts
    .flatMap((part) => {
      const message = byID.get(part.message_id)
      const next = message && candidate(message, part)
      return next ? [next] : []
    })
    .reduce<StoredMessage | undefined>(
      (best, next) => (!best || next.time > best.time ? next : best),
      undefined,
    )
  if (best) return yield* write(db, sessionID, best)
  yield* write(db, sessionID, messages.length < RECOMPUTE ? NONE : null)
})

function read(db: Db, sessionID: string) {
  return db
    .select({ last: SessionTable.last_message })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID as never))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.last ?? null),
    )
}

function write(db: Db, sessionID: string, value: Stored | null) {
  return db
    .update(SessionTable)
    .set({ last_message: value, time_updated: sql`${SessionTable.time_updated}` })
    .where(eq(SessionTable.id, sessionID as never))
    .run()
    .pipe(Effect.orDie, Effect.asVoid)
}
