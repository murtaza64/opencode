/* What a Personal (page-mode) view's restart may lose, counted against the state its page itself restored on load.
 * The baseline is the visible text fields and sessionStorage once the load settled with no user input; afterwards only
 * additions, changes and removals since that baseline count. Values never leave the view's isolated world: entries
 * carry a key and a hash, and the result only counts. */

/** A field or sessionStorage entry: a stable key within the document and a hash of its value. */
export type Entry = { key: string; hash: string }
export type Snapshot = { fields: Entry[]; session: Entry[] }
export type Unsupported = { password: boolean; file: boolean; contenteditable: boolean; frame: boolean; shadow: boolean; selection: boolean }
export type GuardResult = {
  version: 1
  /** False when there is no usable baseline: the restart's loss is unknown and must hold. */
  valid: boolean
  reason?: "interacted" | "not-settled" | "navigated"
  generation: string
  urlMatch: boolean
  interacted: boolean
  fieldsAdded: number
  fieldsChanged: number
  fieldsRemoved: number
  ssAdded: number
  ssChanged: number
  ssRemoved: number
  unsupported: Unsupported
  /** The page's state now, independent of the load baseline (v1 readers ignore it). */
  current: CurrentState
  /** Whether a restart may proceed without asking: the load baseline shows no loss, or (re-baselined on the page's
   * current state) no field holds user text a restart would lose, no input for QUIET_MS, nothing loading or submitting
   * and no dialog. Any unsupported input stops it. */
  admit: boolean
  /** Which rule admitted or stopped: the load baseline, or the current state ("rebaselined" after browsing). */
  admitBasis: "baseline" | "current"
  /** Why `admit` is false (first reason). */
  holdReason?: "unsupported" | "loss" | "dirty" | "typing" | "loading" | "submitting" | "dialog"
}

/** What the page shows now: fields holding user-entered values (counts only), time since the last trusted edit, an
 * unfinished load or form submission, and open modal dialogs. */
export type CurrentState = { dirtyFields: number; quietMs: number; loading: boolean; submitting: boolean; dialogs: number }

export const SETTLE_MS = 2000
/** No trusted edit for this long before a current-state admission: typing, a paste or an app reacting to them is over. */
export const QUIET_MS = 5000

/** Counts of entries added, changed and removed between two lists keyed by `key`. */
export const diffEntries = (baseline: Entry[], current: Entry[]) => {
  const before = new Map(baseline.map((entry) => [entry.key, entry.hash]))
  const after = new Map(current.map((entry) => [entry.key, entry.hash]))
  return {
    added: [...after.keys()].filter((key) => !before.has(key)).length,
    changed: [...after].filter(([key, hash]) => before.has(key) && before.get(key) !== hash).length,
    removed: [...before.keys()].filter((key) => !after.has(key)).length,
  }
}

/** The guard's answer for one read: invalid (counts zero) unless a settled, uninterrupted baseline exists for this URL. */
export const guardResult = (input: {
  generation: string
  baseline?: Snapshot & { url: string }
  interactedBeforeBaseline: boolean
  interacted: boolean
  url: string
  current: Snapshot
  unsupported: Unsupported
  state: CurrentState
}): GuardResult => {
  const urlMatch = !!input.baseline && input.baseline.url === input.url
  const reason = input.interactedBeforeBaseline ? "interacted" as const : !input.baseline ? "not-settled" as const : !urlMatch ? "navigated" as const : undefined
  const fields = input.baseline && !reason ? diffEntries(input.baseline.fields, input.current.fields) : { added: 0, changed: 0, removed: 0 }
  const session = input.baseline && !reason ? diffEntries(input.baseline.session, input.current.session) : { added: 0, changed: 0, removed: 0 }
  const loss = fields.added + fields.changed + fields.removed + session.added + session.changed + session.removed
  // A valid load baseline with no input since is the original rule. Otherwise (browsed, typed and sent, navigated in the
  // app) the decision rests on what the page holds now; the load baseline is not consulted.
  const admitBasis = !reason && !input.interacted ? "baseline" as const : "current" as const
  const state = input.state
  const holdReason = Object.values(input.unsupported).some(Boolean) ? "unsupported" as const
    : admitBasis === "baseline" && loss > 0 ? "loss" as const
    : state.loading ? "loading" as const
    : state.submitting ? "submitting" as const
    : state.dialogs > 0 ? "dialog" as const
    : admitBasis === "current" && state.dirtyFields > 0 ? "dirty" as const
    : admitBasis === "current" && state.quietMs < QUIET_MS ? "typing" as const
    : undefined
  return {
    version: 1, valid: !reason, ...(reason ? { reason } : {}), generation: input.generation, urlMatch, interacted: input.interacted,
    fieldsAdded: fields.added, fieldsChanged: fields.changed, fieldsRemoved: fields.removed,
    ssAdded: session.added, ssChanged: session.changed, ssRemoved: session.removed, unsupported: input.unsupported,
    current: state, admit: !holdReason, admitBasis, ...(holdReason ? { holdReason } : {}),
  }
}

/** A 53-bit string hash (cyrb53), synchronous so a read needs no promise; values stay in the world either way. */
export const hashValue = (value: string) => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
