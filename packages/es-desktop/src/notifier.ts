/* OS notifications for each host's actionable items while Editspace runs. Each host's existing
 * dashboard event stream (`/es/api/notification-events`) triggers one refetch of its attention
 * views and pending requests; there is no timer. The first read of a host only records what is
 * already waiting, so launching never replays the backlog. Notifications post only while the
 * window is not focused; a focused window still advances the ledger so blurring later does not
 * replay what the user was looking at. Read-only: nothing is marked seen or answered. */
import WebSocket from "ws"
import { reconcile, type AttentionItem, type Ledger, type Notice, type NotifyAction, type RequestItem } from "./notify"

export type NotifyHost = {
  /** Verified host ID; part of every notification tag, so a host keeps its notifications across ports. */
  id: string
  read: (path: string, signal?: AbortSignal) => Promise<Response>
  /** Runs `onEvent` for each event on the host's dashboard stream until it ends; true if it opened. */
  events: (onEvent: () => void, signal: AbortSignal) => Promise<boolean>
}

export type Shown = { close: () => void }

/** In-app path a click opens, or undefined when the item's IDs are not well formed. */
export type Route = string | undefined

/** Stands in for the items of a burst past the first few, so a backlog never floods the screen. */
export type Summary = { kind: "summary"; title: string }

export type NotifierOptions = {
  /** True while the user is looking at this host: window focused and its tab shown. */
  focused: (host: string) => boolean
  show: (notice: (Notice | Summary) & { tag: string; host: string; route: Route }) => Shown
  now?: () => number
  /** Reconnect delay after a stream ends; doubles to 30 s. */
  retry?: number
}

// Views holding records the reconcile can alert on: open decisions, plus answered/decided ones
// that may be stalled or blocked in delivery.
const VIEWS = ["open", "answered", "recorded"]
// Records per editspace per view; the dashboard returns at most this many, oldest first.
const LIMIT = 200
// Individual notifications one read may post; the rest of a burst collapses into one summary.
const BURST = 3

export const watchNotifications = (hosts: NotifyHost[], options: NotifierOptions) => {
  const state = { ledger: {} as Ledger, stopped: false }
  const shown = new Map<string, Shown>()
  const controller = new AbortController()

  // Projects whose ledger this device has read at least once, per host. Items of a project first
  // read later (unavailable at launch, or newly registered) are a baseline too, never a backlog.
  const known = new Map<string, Set<string>>()
  // Per host, tags whose items were folded into the summary instead of posted.
  const folded = new Map<string, Set<string>>()

  /** True when the host was read and reconciled; an unreadable host changes nothing. */
  const check = async (host: NotifyHost, baseline: boolean) => {
    const read = await readHost(host)
    // An unreadable host keeps its notifications: absence is not evidence of resolution.
    if (!read || state.stopped) return false
    const result = reconcile({ origin: host.id, attention: read.attention, requests: read.requests, ledger: state.ledger, now: (options.now ?? Date.now)() })
    // A project whose ledger could not be read, or was cut off at the page limit, keeps its
    // notifications: an item missing from it may still be waiting.
    const kept = (tag: string) => {
      const editspace = tag.slice(host.id.length + 1).split("|")[0]!
      return read.unavailable.has(editspace) || read.truncated.has(editspace)
    }
    const actions = result.actions.filter((action) => action.op !== "cancel" || !kept(action.tag))
    state.ledger = { ...result.ledger, ...Object.fromEntries(Object.entries(state.ledger).filter(([tag]) => tag.startsWith(`${host.id}|`) && kept(tag) && !(tag in result.ledger))) }
    const seen = known.get(host.id) ?? new Set<string>()
    // A dashboard without a projects list cannot report availability, so after the launch
    // baseline every new item notifies; the burst cap bounds a recovered project's backlog.
    const fresh = (action: NotifyAction) => read.listed && action.op !== "cancel" && action.tag.includes("|att:") && !seen.has(action.editspace)
    const skipped = folded.get(host.id) ?? new Set<string>()
    const posts = actions.flatMap((action) => {
      shown.get(action.tag)?.close()
      shown.delete(action.tag)
      skipped.delete(action.tag)
      if (action.op === "cancel" || baseline || fresh(action) || options.focused(host.id)) return []
      return [action]
    })
    for (const action of posts.slice(0, BURST)) shown.set(action.tag, options.show({ ...action, host: host.id, route: route(action) }))
    for (const action of posts.slice(BURST)) skipped.add(action.tag)
    folded.set(host.id, skipped)
    const summary = `${host.id}|summary`
    // The summary counts folded items still waiting and closes once none are.
    if (posts.length > BURST || skipped.size === 0) {
      shown.get(summary)?.close()
      shown.delete(summary)
    }
    if (posts.length > BURST)
      shown.set(summary, options.show({ kind: "summary", title: `${skipped.size} more items need you`, tag: summary, host: host.id, route: undefined }))
    known.set(host.id, new Set([...seen, ...read.available]))
    return true
  }

  // One read in flight per host; a nudge during a read runs one more read after it.
  const run = (host: NotifyHost) => {
    const flags = { busy: false, again: false, baseline: true }
    const go = (): void => {
      if (flags.busy) {
        flags.again = true
        return
      }
      flags.busy = true
      const baseline = flags.baseline
      void check(host, baseline)
        // Only a successful read ends the launch baseline; a failed first read must not make the
        // next good read replay everything already waiting.
        .then((ok) => {
          if (ok) flags.baseline = false
        }, () => undefined)
        .finally(() => {
          flags.busy = false
          if (flags.again && !state.stopped) {
            flags.again = false
            go()
          }
        })
    }
    return go
  }

  for (const host of hosts) {
    const refetch = run(host)
    void (async () => {
      const delay = { ms: options.retry ?? 1_000 }
      while (!state.stopped) {
        const opened = await host.events(refetch, controller.signal).catch(() => false)
        if (state.stopped) return
        if (opened) delay.ms = options.retry ?? 1_000
        await new Promise((resolve) => setTimeout(resolve, delay.ms))
        delay.ms = Math.min(delay.ms * 2, 30_000)
      }
    })()
  }

  return {
    stop: () => {
      state.stopped = true
      controller.abort()
      for (const item of shown.values()) item.close()
      shown.clear()
    },
  }
}

// Item IDs come from a host and are lower trust: a click only opens well-formed record or
// session routes on that host's own app.
const EDITSPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const RECORD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SESSION = /^ses_[A-Za-z0-9]{1,64}$/

/** Where a click lands inside the host's app. */
export const route = (notice: Notice): Route => {
  if (notice.kind === "permission" || notice.kind === "question")
    return SESSION.test(notice.session ?? "") ? `/session/${encodeURIComponent(notice.session!)}` : undefined
  if (!EDITSPACE.test(notice.editspace) || !RECORD.test(notice.id)) return undefined
  return `/?item=${encodeURIComponent(`attention:${notice.editspace}:${notice.id}`)}`
}

// Every event, including the initial `connected`, refetches: `attention` and `refresh` (pending
// requests) both change what may need the human, and a reconnect may have missed changes.

/** A host read over HTTP server-sent events (a page host's gateway, with its own sign-in). */
export const sseEvents = (read: NotifyHost["read"]): NotifyHost["events"] => async (onEvent, signal) => {
  const response = await read("/es/api/notification-events", signal)
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    return false
  }
  const decoder = new TextDecoder()
  const buffer = { text: "" }
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer.text += decoder.decode(chunk, { stream: true })
    const events = buffer.text.split("\n\n")
    buffer.text = events.pop() ?? ""
    if (events.some((event) => event.split("\n").some((line) => line.startsWith("data:")))) onEvent()
  }
  return true
}

/** A host read through a desktop listener's event mux, the same socket the app page uses. */
export const muxEvents = (origin: string, key: string): NotifyHost["events"] => (onEvent, signal) =>
  new Promise((resolve) => {
    const path = "/es/api/notification-events"
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}${path}`, "opencode-events-v1", { headers: { origin, "x-editspace-key": key } })
    const state = { opened: false }
    const stop = () => socket.close()
    signal.addEventListener("abort", stop, { once: true })
    socket.once("open", () => {
      state.opened = true
      socket.send(JSON.stringify({ type: "subscribe", id: 1, url: path }))
    })
    socket.on("message", (data) => {
      const packet = parse(String(data))
      if (packet?.type === "message" && packet.id === 1) onEvent()
      // The upstream stream failed; reconnect rather than sit on a dead subscription.
      if (packet?.type === "error") socket.close()
    })
    socket.once("error", () => undefined)
    socket.once("close", () => {
      signal.removeEventListener("abort", stop)
      resolve(state.opened)
    })
  })

const parse = (text: string): { type?: unknown; id?: unknown } | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return record(value) ? value : undefined
  } catch {
    return undefined
  }
}

const readHost = async (host: NotifyHost) => {
  const [requests, ...views] = await Promise.all([
    json(host, "/es/api/notifications"),
    ...VIEWS.map((view) => json(host, `/es/api/attention?view=${view}&limit=${LIMIT}`)),
  ])
  if (!record(requests) || !Array.isArray(requests.notifications)) return undefined
  if (!views.every((view) => record(view) && Array.isArray(view.records))) return undefined
  const pages = views.map((view) => (view as { records: unknown[] }).records.filter(isAttention))
  return {
    requests: requests.notifications.filter(isRequest),
    attention: pages.flat(),
    truncated: new Set(pages.flatMap((page) => [...Map.groupBy(page, (item) => item.editspace)].filter(([, items]) => items.length >= LIMIT).map(([editspace]) => editspace))),
    unavailable: projects(views, false),
    available: projects(views, true),
    listed: views.some((view) => Array.isArray((view as { projects?: unknown }).projects)),
  }
}

const projects = (views: unknown[], available: boolean) =>
  new Set(
    views.flatMap((view) => {
      const list = (view as { projects?: unknown }).projects
      return Array.isArray(list) ? list.filter((item) => record(item) && (item.available !== false) === available && typeof item.editspace === "string").map((item) => (item as { editspace: string }).editspace) : []
    }),
  )

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const isAttention = (value: unknown): value is AttentionItem =>
  record(value) && typeof value.id === "string" && typeof value.editspace === "string" && typeof value.status === "string" && typeof value.revision === "number" && typeof value.title === "string"

const isRequest = (value: unknown): value is RequestItem =>
  record(value) && typeof value.id === "string" && typeof value.kind === "string" && typeof value.editspace === "string" && typeof value.session === "string" && typeof value.title === "string"

const json = (host: NotifyHost, path: string): Promise<unknown> =>
  host
    .read(path, AbortSignal.timeout(10_000))
    .then(async (response) => {
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel()
        return undefined
      }
      return response.json()
    })
    .catch(() => undefined)
