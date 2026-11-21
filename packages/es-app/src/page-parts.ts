import type { Part } from "@opencode-ai/sdk/v2"

// A compact message page bounds long tool output (state.metadata.pageTruncated). Opening such a tool row asks the live
// session that owns it to read the full part once; the row then renders the real output from the live store.
type Hydrator = (messageID: string, partID: string) => Promise<void>
const hydrators = new Map<string, Hydrator>()
const pending = new Set<string>()

export const registerHydrator = (sessionID: string, hydrate: Hydrator) => {
  hydrators.set(sessionID, hydrate)
  return () => {
    if (hydrators.get(sessionID) === hydrate) hydrators.delete(sessionID)
  }
}

/** The page cut this part's output or replaced its attachments (dropping only a metadata preview does not count). */
export const shortened = (part: Part) => {
  if (part.type !== "tool" || part.state.status !== "completed") return false
  const cut = part.state.metadata?.pageTruncated as { output?: number; attachments?: unknown[] } | undefined
  return !!cut && ((cut.output ?? 0) > part.state.output.length || (cut.attachments?.length ?? 0) > 0)
}

/** Fetch the full part if a compact page shortened it; at most one read in flight per part. */
export const hydrate = (part: Part) => {
  if (!shortened(part) || pending.has(part.id)) return
  const run = hydrators.get(part.sessionID)
  if (!run) return
  pending.add(part.id)
  void run(part.messageID, part.id).catch(() => undefined).finally(() => pending.delete(part.id))
}
