/* Find in one Surface frame (DD #672/#676). A Surface is an opaque-origin sandboxed frame, so the app cannot read it
 * and webContents.findInPage would also search the app around it. Instead the main process enters that one frame
 * through the DevTools protocol, in an isolated world of its own, and runs a fixed helper that highlights matches with
 * the CSS Custom Highlight API (no DOM nodes added or changed) in the frame and its same-origin child frames. Only
 * {current, total} comes back: no text or DOM leaves the frame. The sandbox, CSP and served bytes are untouched.
 * The debugger attaches on the first find and detaches when the find bar closes. */
import type { WebContents, WebFrameMain } from "electron"

export type FindRequest = { frame: string; action: "find" | "next" | "previous" | "clear"; query?: string }
export type FindResult = { state: "ok"; current: number; total: number } | { state: "unavailable"; reason: FindUnavailable }
export type FindUnavailable = "no-frame" | "busy-debugger" | "blocked" | "unsupported"

// A Surface frame address as the reader sets it: this host's or a Work host's capability path, ending at its directory.
export const SURFACE_FRAME = /^\/__cap\/(?:host\/[a-z][a-z0-9-]{0,31}\/)?surface\/[a-z0-9][a-z0-9-]{0,39}\/[0-9a-z]{1,12}-[0-9a-f]{32}\/$/
const WORLD = "editspace-surface-find"
const MAX_QUERY = 200

export const findRequest = (body: unknown): FindRequest | undefined => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  if (Object.keys(record).some((key) => !["frame", "action", "query"].includes(key))) return undefined
  if (typeof record.frame !== "string" || !SURFACE_FRAME.test(record.frame)) return undefined
  if (!["find", "next", "previous", "clear"].includes(record.action as string)) return undefined
  if (record.action !== "clear" && (typeof record.query !== "string" || record.query.length > MAX_QUERY)) return undefined
  return { frame: record.frame, action: record.action as FindRequest["action"], ...(typeof record.query === "string" ? { query: record.query } : {}) }
}

type Session = {
  send: (method: string, params?: object, sessionId?: string) => Promise<any>
  targets: Set<string>
  worlds: Map<string, number>
}

/** One finder per app view: `contents()` is the view the reader runs in, `origin` its listener origin. */
export const surfaceFinder = (contents: () => WebContents | undefined, origin: () => string) => {
  const sessions = new WeakMap<WebContents, Session>()

  const attach = async (view: WebContents): Promise<Session | FindUnavailable> => {
    const known = sessions.get(view)
    if (known) return known
    // Someone else (DevTools protocol client) holds this view's debugger: never share or steal it.
    if (view.debugger.isAttached()) return "busy-debugger"
    view.debugger.attach("1.3")
    const session: Session = {
      send: (method, params, sessionId) => view.debugger.sendCommand(method, params, sessionId),
      targets: new Set(),
      worlds: new Map(),
    }
    const autoAttach = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }
    view.debugger.on("message", (_event, method, params, sessionId) => {
      // Out-of-process child frames (a sandboxed Surface usually is one) are separate targets with their own sessions.
      if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe") {
        session.targets.add(params.sessionId)
        void session.send("Target.setAutoAttach", autoAttach, params.sessionId).catch(() => undefined)
      }
      if (method === "Target.detachedFromTarget") session.targets.delete(params.sessionId)
    })
    view.debugger.once("detach", () => sessions.delete(view))
    sessions.set(view, session)
    await session.send("Target.setAutoAttach", autoAttach)
    // Existing child frames announce themselves as events right after auto-attach starts.
    await new Promise((resolve) => setTimeout(resolve, 150))
    return session
  }

  // The Surface frame (by its capability directory) and the protocol session that can run code in it.
  const locate = async (session: Session, prefix: string) => {
    for (const sessionId of [...session.targets, undefined]) {
      const tree = await session.send("Page.getFrameTree", {}, sessionId).catch(() => undefined)
      const walk = (node: any): string | undefined =>
        typeof node?.frame?.url === "string" && node.frame.url.startsWith(prefix) ? node.frame.id : (node?.childFrames ?? []).map(walk).find(Boolean)
      const frameId = tree && walk(tree.frameTree)
      if (frameId) return { frameId: frameId as string, sessionId }
    }
    return undefined
  }

  const run = async (session: Session, where: { frameId: string; sessionId?: string }, input: FindRequest) => {
    const key = `${where.sessionId ?? ""}:${where.frameId}`
    const evaluate = async (contextId: number) =>
      session.send("Runtime.evaluate", { expression: `(${HELPER})(${JSON.stringify(input)})`, contextId, returnByValue: true }, where.sessionId)
    const fresh = async () => {
      const world = await session.send("Page.createIsolatedWorld", { frameId: where.frameId, worldName: WORLD, grantUniveralAccess: false }, where.sessionId)
      session.worlds.set(key, world.executionContextId)
      return world.executionContextId as number
    }
    // A navigation inside the Surface drops its world; make a new one and run again (the query travels with each call).
    const reply = await evaluate(session.worlds.get(key) ?? (await fresh())).catch(async () => evaluate(await fresh()))
    return reply?.result?.value
  }

  return async (input: FindRequest): Promise<FindResult> => {
    const view = contents()
    if (!view || view.isDestroyed()) return { state: "unavailable", reason: "no-frame" }
    if (input.action === "clear" && !sessions.has(view)) return { state: "ok", current: 0, total: 0 }
    const session = await attach(view).catch(() => "blocked" as const)
    if (typeof session === "string") return { state: "unavailable", reason: session }
    try {
      const where = await locate(session, `${origin()}${input.frame}`)
      if (!where) return { state: "unavailable", reason: "no-frame" }
      const value = await run(session, where, input).catch(() => undefined)
      if (value === "unsupported") return { state: "unavailable", reason: "unsupported" }
      // Only two bounded integers are accepted back from the frame's world.
      if (!value || !Number.isInteger(value.current) || !Number.isInteger(value.total)) return { state: "unavailable", reason: "blocked" }
      return { state: "ok", current: Math.max(0, Math.min(value.current, value.total)), total: Math.max(0, Math.min(value.total, MAX_MATCHES)) }
    } finally {
      if (input.action === "clear" && view.debugger.isAttached()) view.debugger.detach()
    }
  }
}

const MAX_MATCHES = 1000

/** Whether keyboard focus is in a Surface frame (or a frame nested in one) of this view. */
export const surfaceFrameFocused = (focused: WebFrameMain | null | undefined, main: WebFrameMain) => {
  for (let frame = focused; frame && frame !== main; frame = frame.parent) {
    const pathname = URL.parse(frame.url)?.pathname ?? ""
    if (/^\/__cap\/(?:host\/[a-z][a-z0-9-]{0,31}\/)?surface\//.test(pathname)) return true
  }
  return false
}

// Runs inside the Surface frame's isolated world. State lives on that world's global, never on the page's.
const HELPER = String((input: { action: string; query?: string }) => {
  const NAME = "editspace-find"
  const CURRENT = "editspace-find-current"
  const LIMIT = 1000
  const self = globalThis as any
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return "unsupported"
  const state = (self.__editspaceFind ??= { query: "", ranges: [] as Range[], index: -1, docs: [] as Document[], sheets: new Map() })
  const documents = () => {
    const found: Document[] = []
    const visit = (doc: Document) => {
      found.push(doc)
      for (const frame of Array.from(doc.querySelectorAll("iframe, frame"))) {
        try {
          const child = (frame as HTMLIFrameElement).contentDocument
          if (child) visit(child)
        } catch {
          // A cross-origin child frame is not searched.
        }
      }
    }
    visit(document)
    return found
  }
  const registry = (doc: Document) => (doc.defaultView as any)?.CSS?.highlights as Map<string, unknown> | undefined
  const clear = () => {
    for (const doc of state.docs) {
      registry(doc)?.delete(NAME)
      registry(doc)?.delete(CURRENT)
      const sheet = state.sheets.get(doc)
      if (sheet) doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((item: CSSStyleSheet) => item !== sheet)
    }
    state.sheets = new Map()
    state.ranges = []
    state.docs = []
    state.index = -1
    state.query = ""
  }
  const search = (query: string) => {
    clear()
    state.query = query
    if (!query) return
    const needle = query.toLocaleLowerCase()
    for (const doc of documents()) {
      state.docs.push(doc)
      if (!doc.body) continue
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const parent = node.parentElement
          if (!parent || parent.closest("script, style, noscript, template")) return NodeFilter.FILTER_REJECT
          if ("checkVisibility" in parent && !parent.checkVisibility()) return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        },
      })
      for (let node = walker.nextNode(); node && state.ranges.length < LIMIT; node = walker.nextNode()) {
        const text = (node.nodeValue ?? "").toLocaleLowerCase()
        for (let at = text.indexOf(needle); at !== -1 && state.ranges.length < LIMIT; at = text.indexOf(needle, at + needle.length)) {
          const range = doc.createRange()
          range.setStart(node, at)
          range.setEnd(node, at + needle.length)
          state.ranges.push(range)
        }
      }
      const view = doc.defaultView as any
      const sheet = new view.CSSStyleSheet()
      sheet.replaceSync(`::highlight(${NAME}){background-color:#f5d76e;color:#111}::highlight(${CURRENT}){background-color:#f08c2e;color:#111}`)
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
      state.sheets.set(doc, sheet)
    }
    state.index = state.ranges.length ? 0 : -1
  }
  const paint = () => {
    for (const doc of state.docs) {
      const view = doc.defaultView as any
      const mine = state.ranges.filter((range: Range) => range.startContainer.ownerDocument === doc)
      registry(doc)?.set(NAME, new view.Highlight(...mine))
      const current = state.ranges[state.index]
      if (current && current.startContainer.ownerDocument === doc) registry(doc)?.set(CURRENT, new view.Highlight(current))
      else registry(doc)?.delete(CURRENT)
    }
    state.ranges[state.index]?.startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" })
  }
  if (input.action === "clear") {
    clear()
    return { current: 0, total: 0 }
  }
  const query = input.query ?? ""
  if (input.action === "find" || query !== state.query) search(query)
  else if (state.ranges.length && input.action === "next") state.index = (state.index + 1) % state.ranges.length
  else if (state.ranges.length && input.action === "previous") state.index = (state.index - 1 + state.ranges.length) % state.ranges.length
  paint()
  return { current: state.index + 1, total: state.ranges.length }
})
