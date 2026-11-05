import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { link, mkdir, unlink, writeFile } from "fs/promises"
import path from "path"

/**
 * A held orphan: the newest step answering the newest prompt was left open by a lost server process and has an
 * effect the advisory wake must not resume. One `crash-observed` incident source is written per held Session per
 * process generation so its owner can be told. It is display and notification input only: it is never a revival
 * roster (no capturedAt, no manifest) and recovery code never reads it.
 */
// Matches the incident dispatcher (dotfiles es_restart_incident_lib CRASH_REASONS).
export type Reason = "unknown-effect" | "provider-failure" | "explicit-stop" | "summary" | "restart-marker"

export const KIND = "crash-observed"

export const generation = (started: number) => `${started}-${process.pid}`

/** The restart directory oc-server uses (overridable the same way), so incident routing finds these files. */
export const directory = () => process.env.OC_RESTART_DIR ?? path.join(Global.Path.data, "restarts")

export function classify(
  user: SessionV1.User | undefined,
  assistant: SessionV1.Assistant | undefined,
  parts: readonly SessionV1.Part[],
  started: number,
): Reason | undefined {
  if (!user) return
  // The process died after promoting the prompt but before opening its step: nothing records whether the provider
  // was already called, so the turn holds and its owner decides.
  if (!assistant || assistant.parentID !== user.id) return user.time.created < started ? "unknown-effect" : undefined
  // Only steps left open: a finished or failed step is not something the lost process cut off.
  if (assistant.time.completed !== undefined) return
  const times = [
    assistant.time.created,
    ...parts.flatMap((part) => {
      const time = (part.type === "tool" ? part.state : part) as { time?: { start?: number; end?: number } }
      return [time.time?.start, time.time?.end]
    }),
  ].filter((value): value is number => typeof value === "number")
  if (!times.every((time) => time < started)) return
  if (assistant.restarts?.length) return "restart-marker"
  if (assistant.summary) return "summary"
  if (assistant.error) return assistant.error.name === "MessageAbortedError" ? "explicit-stop" : "provider-failure"
  if (parts.some((part) => part.type === "tool" && part.state.status !== "completed")) return "unknown-effect"
}

// Sessions recorded by this process; a held orphan is refused on every wake, so skip the reads after the first.
const recorded = new Set<string>()

export const seen = (sessionID: string) => recorded.has(sessionID)

export const record = Effect.fnUntraced(function* (input: {
  started: number
  sessionID: string
  directory: string
  /** The open step, or the unanswered prompt when the process died before opening one. */
  anchor: { id: string; time: { created: number } }
  parts: readonly SessionV1.Part[]
  reason: Reason
  pendingInputs: number
  fenced: boolean
}) {
  const id = generation(input.started)
  const file = path.join(directory(), `crash-${id}-${input.sessionID}.incident-source.json`)
  const body = {
    kind: KIND,
    version: 1,
    generation: id,
    previous_generation: null,
    observed_at_ms: Date.now(),
    source: "core-wake-guard",
    core_release: InstallationVersion,
    core_binary_sha256: null,
    session: {
      session: input.sessionID,
      directory: input.directory,
      lane: null,
      anchor: input.anchor.id,
      anchor_created_ms: input.anchor.time.created,
      reason: input.reason,
      // Names and statuses only: never tool input, output or command text.
      tools: input.parts.flatMap((part) => (part.type === "tool" ? [{ tool: part.tool, status: part.state.status }] : [])),
      pending_inputs: input.pendingInputs,
      fenced: input.fenced,
      recorded_owner: null,
    },
  }
  // Write-once per Session and generation, never partial: write a temp file, then hard-link it into place, which
  // fails when the file already exists (already recorded).
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  recorded.add(input.sessionID)
  return yield* Effect.tryPromise(async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(temp, JSON.stringify(body, null, 2), { mode: 0o600 })
    try {
      await link(temp, file)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
      throw error
    } finally {
      await unlink(temp).catch(() => {})
    }
  }).pipe(
    // A missing incident must be visible: its owner would not be told about the held Session.
    Effect.catch((cause) =>
      Effect.logWarning("crash incident source not written", { sessionID: input.sessionID, file, error: String(cause) }).pipe(
        Effect.as(false),
      ),
    ),
  )
})

export * as SessionCrashIncident from "./crash-incident"
