import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema, Semaphore } from "effect"
import { isDeepStrictEqual } from "node:util"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { SessionID, MessageID } from "./schema"
import { Config } from "@/config/config"
import { MessageV2 } from "./message-v2"
import { NotFoundError } from "@/storage/storage"
import { Database } from "@opencode-ai/core/database/database"

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

/** UTF-8 bytes of patch text a user message summary carries inline when the budget is enabled. */
export const INLINE_PATCH_BUDGET = 256 * 1024

/**
 * Rollout gate for omitting summary patches. Clients that predate `patchOmitted` render an omitted patch as an empty
 * diff, so the budget applies only when the operator sets `OPENCODE_SUMMARY_PATCH_BUDGET` (bytes, or `1` for the
 * default) after confirming every client reading summary patches understands it. Unset keeps every patch inline.
 */
export function patchBudget(value = process.env.OPENCODE_SUMMARY_PATCH_BUDGET) {
  if (!value) return
  const bytes = Number(value)
  if (!Number.isInteger(bytes) || bytes < 1) return
  return bytes === 1 ? INLINE_PATCH_BUDGET : bytes
}
/** Turn ranges remembered per user message, so an unchanged range is neither recomputed nor rebroadcast. */
const RANGES = 1_000

/**
 * Keep every file's status and counts; inline patches in diff order while they fit the budget and mark the rest
 * `patchOmitted`, so a reader can tell an omitted patch from an empty one.
 */
export function bound(diffs: readonly Snapshot.FileDiff[], budget = patchBudget()): Snapshot.FileDiff[] {
  if (budget === undefined) return [...diffs]
  let used = 0
  return diffs.map((diff) => {
    if (diff.patch === undefined) return diff
    const size = Buffer.byteLength(diff.patch)
    if (used + size <= budget) {
      used += size
      return diff
    }
    const { patch: _, ...metadata } = diff
    return { ...metadata, patchOmitted: true as const }
  })
}

/** The turn's first step-start snapshot and last step-finish snapshot. */
function range(messages: readonly SessionV1.WithParts[]) {
  let from: string | undefined
  let to: string | undefined
  for (const item of messages) {
    if (!from)
      from = item.parts.flatMap((part) => (part.type === "step-start" && part.snapshot ? [part.snapshot] : []))[0]
    for (const part of item.parts) if (part.type === "step-finish" && part.snapshot) to = part.snapshot
  }
  return from && to ? { from, to } : undefined
}

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: { messages: SessionV1.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const database = yield* Database.Service

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: SessionV1.WithParts[] }) {
      const turn = range(input.messages)
      if (turn) return yield* snapshot.diffFull(turn.from, turn.to)
      return []
    })

    // Every step-finish asks for a summary of the whole turn. Serialize per message and remember the summarized
    // range: a step that changed nothing must not rebuild and rebroadcast a payload that can be megabytes.
    const summarized = new Map<MessageID, string>()
    const locks = new Map<MessageID, { semaphore: Semaphore.Semaphore; users: number }>()
    const exclusive = <A, E, R>(messageID: MessageID, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const entry = locks.get(messageID) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
          entry.users++
          locks.set(messageID, entry)
          return entry
        }),
        (entry) => entry.semaphore.withPermits(1)(effect),
        (entry) =>
          Effect.sync(() => {
            entry.users--
            if (entry.users === 0) locks.delete(messageID)
          }),
      )
    const remember = (messageID: MessageID, key: string) => {
      summarized.delete(messageID)
      summarized.set(messageID, key)
      if (summarized.size > RANGES) summarized.delete(summarized.keys().next().value!)
    }

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const reset = Effect.gen(function* () {
        yield* sessions.setSummary({
          sessionID: input.sessionID,
          summary: {
            additions: 0,
            deletions: 0,
            files: 0,
          },
        })
        yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: [] })
      })
      if ((yield* config.get()).snapshot === false) return yield* reset
      yield* exclusive(
        input.messageID,
        Effect.gen(function* () {
          const messages = yield* MessageV2.turn(input).pipe(Effect.provideService(Database.Service, database))
          const target = messages.find((m) => m.info.id === input.messageID)
          const turn = range(messages)
          const key = turn ? `${turn.from}..${turn.to}` : ""
          if (summarized.get(input.messageID) === key) return
          yield* reset
          if (!target || target.info.role !== "user") return
          const diffs = bound(turn ? yield* snapshot.diffFull(turn.from, turn.to) : [])
          if (!isDeepStrictEqual(target.info.summary?.diffs, diffs)) {
            target.info.summary = { ...target.info.summary, diffs }
            yield* sessions.updateMessage(target.info)
          }
          remember(input.messageID, key)
        }),
      )
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      if (!input.messageID) return []
      const message = yield* MessageV2.get({ sessionID: input.sessionID, messageID: input.messageID }).pipe(
        Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)),
        Effect.provideService(Database.Service, database),
      )
      if (!message || message.info.role !== "user") return []
      const stored = message.info.summary?.diffs ?? []
      // This route is the deliberate review read: rebuild patches the inline summary omitted. A patch the snapshot
      // store can no longer produce stays marked omitted rather than turning into an empty diff.
      const full = stored.some((item) => item.patchOmitted)
        ? yield* MessageV2.turn({ sessionID: input.sessionID, messageID: input.messageID }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.flatMap((messages) => computeDiff({ messages })),
          )
        : []
      const rebuilt = new Map(full.flatMap((item) => (item.file !== undefined && item.patch ? [[item.file, item]] : [])))
      const diffs = stored.map((item) => {
        const hit = item.patchOmitted && item.file !== undefined ? rebuilt.get(item.file) : undefined
        // The turn may have moved on since it was summarized; a patch for different counts would misdescribe the
        // stored row, so it stays omitted.
        if (!hit || hit.additions !== item.additions || hit.deletions !== item.deletions || hit.status !== item.status)
          return item
        const { patchOmitted: _, ...metadata } = item
        return { ...metadata, patch: hit.patch }
      })
      return diffs.map((item) => {
        if (item.file === undefined) return item
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return { ...item, file }
      })
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, Snapshot.node, EventV2Bridge.node, Config.node, Database.node],
})

export * as SessionSummary from "./summary"
