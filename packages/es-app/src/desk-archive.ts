/* Porter's memory archive (dotfiles#295): markdown docs and per-session summaries the desk recalls by search, beside
 * the hot notes in memory.json. The dashboard owns the files (one git commit per edit); this client reads them and
 * changes one doc at a time by compare-and-set on its sha256 ("" for a new doc). Never polled: read when shown. */

export type ArchiveDocInfo = { slug: string; path: string; chars: number; updated: number }
export type ArchiveDoc = { slug: string; path: string; text: string; sha256: string }
export type ArchiveHit = { slug: string; path: string; snippet: string; score: number }

const BASE = "/es/api/frontdesk/archive"
const doc = (slug: string) => `${BASE}/doc/${slug.split("/").map(encodeURIComponent).join("/")}`

/** Session summaries live under `sessions/<date>-<session>`; everything else is a topic doc. */
export const isSummary = (slug: string) => slug.startsWith("sessions/")

/** Why a read or write did not happen, in words the panel shows. `absent`: this dashboard has no archive. */
export class ArchiveFailure extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
  get absent() { return this.status === 404 && /Not Found/.test(this.message) }
  get conflict() { return this.status === 409 }
}

const call = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, { credentials: "include", ...init }).catch(() => undefined)
  if (!response) throw new ArchiveFailure("the dashboard did not answer")
  const body = await response.json().catch(() => undefined) as { error?: string; detail?: string } | undefined
  if (!response.ok) throw new ArchiveFailure(body?.error ?? body?.detail ?? `HTTP ${response.status}`, response.status)
  return body as T
}
const write = (method: "PUT" | "DELETE", body: object): RequestInit =>
  ({ method, headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: JSON.stringify(body) })

export const archive = {
  list: () => call<{ docs: ArchiveDocInfo[] }>(BASE).then(body => body.docs),
  search: (q: string) => call<{ results: ArchiveHit[] }>(`${BASE}/search?q=${encodeURIComponent(q)}`).then(body => body.results),
  read: (slug: string) => call<ArchiveDoc>(doc(slug)),
  /** `expected` is the sha256 the edit started from, "" to create. */
  save: (slug: string, text: string, expected: string) => call<{ slug: string; sha256: string | null }>(doc(slug), write("PUT", { text, expected_sha256: expected })),
  remove: (slug: string, expected: string) => call<{ slug: string; deleted: boolean }>(doc(slug), write("DELETE", { expected_sha256: expected })),
}
