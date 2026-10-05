/* On-demand PR metadata for cited PRs the dashboard does not already carry
 * (dotfiles#139 `/api/pr-detail`). Bounded: a few requests in flight at once,
 * each canonical URL fetched once per TTL, failures remembered briefly so a
 * re-render never hammers GitHub, and a missing endpoint (404/501) disables
 * enrichment for a while. Chips render minimal data until a real answer
 * arrives; nothing here invents state. */
import { createSignal } from "solid-js"
import { ApiStatusError, es } from "./api"

const CONCURRENCY = 3
const TTL_MS = 5 * 60_000
const FAILURE_TTL_MS = 60_000
const UNAVAILABLE_FOR_MS = 10 * 60_000

type Entry = { at: number; data: any | null; failed?: boolean }

const cache = new Map<string, Entry>()
const [version, setVersion] = createSignal(0)
const inflight = new Set<string>()
const queue: string[] = []
let endpointMissingUntil = 0

/** Reactive lookup: the enriched record for a canonical PR URL, or undefined while absent. */
export const prDetail = (url: string) => {
  version()
  const entry = cache.get(url)
  return entry && !entry.failed ? entry.data : undefined
}

export const prDetailPending = (url: string) => inflight.has(url) || queue.includes(url)

const pump = () => {
  if (Date.now() < endpointMissingUntil) queue.length = 0
  while (inflight.size < CONCURRENCY && queue.length) {
    const url = queue.shift()!
    if (inflight.has(url)) continue
    inflight.add(url)
    es.prDetail(url)
      .then((data) => {
        const record = data && typeof data === "object" && typeof data.url === "string" ? data : null
        cache.set(url, { at: Date.now(), data: record, failed: !record })
        setVersion((v) => v + 1)
      })
      .catch((error) => {
        if (error instanceof ApiStatusError && error.routeMissing) endpointMissingUntil = Date.now() + UNAVAILABLE_FOR_MS
        if (error instanceof ApiStatusError && error.status === 429) queue.length = 0
        cache.set(url, { at: Date.now(), data: null, failed: true })
        setVersion((v) => v + 1)
      })
      .finally(() => {
        inflight.delete(url)
        pump()
      })
  }
}

/** Request enrichment for canonical URLs in priority order; cached, in-flight
 * and recently failed URLs are skipped. Safe to call on every render. */
export const requestPrDetails = (urls: string[]) => {
  if (Date.now() < endpointMissingUntil) return
  const now = Date.now()
  for (const url of urls) {
    const entry = cache.get(url)
    if (entry && now - entry.at < (entry.failed ? FAILURE_TTL_MS : TTL_MS)) continue
    if (inflight.has(url) || queue.includes(url)) continue
    queue.push(url)
  }
  pump()
}

export const prDetailsEnabled = () => Date.now() >= endpointMissingUntil

/** test seam */
export const resetPrDetails = () => {
  cache.clear()
  setVersion((v) => v + 1)
  queue.length = 0
  endpointMissingUntil = 0
}
