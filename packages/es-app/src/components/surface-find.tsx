import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js"

/** What the find bar shows: counts from the native shell, or why search is not offered for this Surface. */
type FindState = { current: number; total: number } | { unavailable: true } | undefined

// Whether this window has the native shell's frame search. It is a property of the app, not of one reader:
// a reader mounted for a new Surface uses it at once instead of starting a second probe (the old per-reader
// probe left Cmd+F ignored for the first moments of a navigation).
// The Mac app is the native-find shell; its UA is known synchronously, so a reloaded reader can take Cmd+F
// before the /__es/find probe answers. Kept local (no UI import) so this module has no other side effects.
const nativeShell = typeof navigator !== "undefined" &&
  /\bElectron\/\d/.test(navigator.userAgent) && /Macintosh/.test(navigator.userAgent)
let nativeKnown: boolean | undefined
let nativeProbe: Promise<boolean> | undefined
const probeNative = () => {
  if (nativeKnown !== undefined) return Promise.resolve(nativeKnown)
  return nativeProbe ??= fetch("/__es/find").then(async (response) => {
    const body = response.ok && response.headers.get("content-type")?.includes("application/json") ? await response.json() : undefined
    return body?.available === true
  }).then((value) => { nativeKnown = value; return value }).catch(() => { nativeProbe = undefined; return false })
}

/**
 * Cmd/Ctrl+F for the Surface reader (DD #672/#676). In the Mac app the native shell searches only the shown Surface
 * frame (an isolated world inside that frame) and returns counts; the app never sees the Surface's text. In a plain
 * browser the reader leaves the chord to the browser's own find, which searches the frame too.
 * `frame` is the Surface frame's address as the reader set it (its capability directory).
 */
export const SurfaceFind = (props: { frame: () => string | undefined; trigger?: () => number }) => {
  // Other clients still learn from the probe; the Mac shell knows immediately.
  const [native, setNative] = createSignal(nativeShell || nativeKnown === true)
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [state, setState] = createSignal<FindState>()
  const focus = { before: undefined as HTMLElement | undefined, input: undefined as HTMLInputElement | undefined, timer: 0, serial: 0 }

  onMount(() => { void probeNative().then(setNative) })

  const send = async (action: "find" | "next" | "previous" | "clear", text = query()) => {
    const frame = props.frame()
    if (!frame) return
    const serial = ++focus.serial
    const reply = await fetch("/__es/find", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action === "clear" ? { frame, action } : { frame, action, query: text }),
    }).then((response) => (response.ok ? response.json() : undefined)).catch(() => undefined)
    // Only the newest request paints; a reply is two numbers or a reason, never Surface text.
    if (serial !== focus.serial || action === "clear") return
    if (reply?.state === "ok" && Number.isInteger(reply.current) && Number.isInteger(reply.total)) setState({ current: reply.current, total: reply.total })
    else setState({ unavailable: true })
  }

  const show = () => {
    const active = document.activeElement
    if (!open()) focus.before = active instanceof HTMLElement && active !== document.body ? active : undefined
    setOpen(true)
    queueMicrotask(() => { focus.input?.focus(); focus.input?.select() })
    if (query()) void send("find")
  }
  createEffect(on(() => props.trigger?.(), value => { if (value) show() }, { defer: true }))
  const close = () => {
    clearTimeout(focus.timer)
    setOpen(false)
    setState(undefined)
    void send("clear")
    const before = focus.before
    focus.before = undefined
    if (before?.isConnected) before.focus()
  }

  onMount(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return
      // Typing in a field outside the reader keeps that field's own find (or none).
      const active = document.activeElement
      const editable = active instanceof HTMLElement && active !== focus.input && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))
      if (editable && !active.closest(".desk-surface, .surface-head")) return
      // The reader owns the chord while it is shown: other app finds (session, results) stay closed.
      event.stopImmediatePropagation()
      // A plain browser keeps its native find, which searches the Surface frame too.
      if (!native()) return
      // Open even while the frame address is still loading: the bar can appear, and the effect above
      // searches once the address arrives.
      event.preventDefault()
      show()
    }
    // Cmd/Ctrl+F typed inside the Surface frame, forwarded by the native shell.
    const forwarded = () => { if (native() && props.frame()) show() }
    window.addEventListener("keydown", keydown, true)
    window.addEventListener("editspace-surface-find", forwarded)
    onCleanup(() => {
      window.removeEventListener("keydown", keydown, true)
      window.removeEventListener("editspace-surface-find", forwarded)
      if (open()) void send("clear")
    })
  })

  // A new frame (republish, newer revision, re-minted address) starts without highlights.
  createEffect(on(props.frame, () => { if (open() && query()) { setState(undefined); clearTimeout(focus.timer); focus.timer = window.setTimeout(() => void send("find"), 400) } }, { defer: true }))

  const typed = (value: string) => {
    setQuery(value)
    clearTimeout(focus.timer)
    if (!value) {
      setState(undefined)
      void send("clear")
      return
    }
    focus.timer = window.setTimeout(() => void send("find", value), 150)
  }
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key === "Enter" && query()) {
      event.preventDefault()
      void send(event.shiftKey ? "previous" : "next")
    }
  }
  const status = () => {
    const value = state()
    if (!value || !query()) return ""
    if ("unavailable" in value) return "Search isn't available for this Surface"
    return value.total ? `${value.current} of ${value.total}${value.total >= 1000 ? "+" : ""}` : "No matches"
  }
  const counted = () => { const value = state(); return !!value && !("unavailable" in value) && value.total > 0 }

  return <Show when={open()}>
    <div class="surface-find" role="search" aria-label="Find in Surface">
      <input ref={(element) => (focus.input = element)} class="surface-find-input" type="search" dir="auto" placeholder="Find in Surface"
        aria-label="Find in Surface" value={query()} onInput={(event) => typed(event.currentTarget.value)} onKeyDown={keys} />
      <span class="surface-find-count" role="status" aria-live="polite">{status()}</span>
      <button class="surface-head-button" type="button" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!counted()} onClick={() => void send("previous")}>↑</button>
      <button class="surface-head-button" type="button" aria-label="Next match" title="Next (Enter)" disabled={!counted()} onClick={() => void send("next")}>↓</button>
      <button class="surface-head-button" type="button" aria-label="Close find" title="Close (Esc)" onClick={close}>×</button>
    </div>
  </Show>
}
