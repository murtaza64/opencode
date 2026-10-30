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
}

export const SETTLE_MS = 2000

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
}): GuardResult => {
  const urlMatch = !!input.baseline && input.baseline.url === input.url
  const reason = input.interactedBeforeBaseline ? "interacted" as const : !input.baseline ? "not-settled" as const : !urlMatch ? "navigated" as const : undefined
  const fields = input.baseline && !reason ? diffEntries(input.baseline.fields, input.current.fields) : { added: 0, changed: 0, removed: 0 }
  const session = input.baseline && !reason ? diffEntries(input.baseline.session, input.current.session) : { added: 0, changed: 0, removed: 0 }
  return {
    version: 1, valid: !reason, ...(reason ? { reason } : {}), generation: input.generation, urlMatch, interacted: input.interacted,
    fieldsAdded: fields.added, fieldsChanged: fields.changed, fieldsRemoved: fields.removed,
    ssAdded: session.added, ssChanged: session.changed, ssRemoved: session.removed, unsupported: input.unsupported,
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
