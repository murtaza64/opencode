/* Mounts app-wide keyboard dispatch, the which-key popup and the "?" shortcut
 * overlay. The overlay lists only dispatched registry bindings, so every row is a
 * key that works on this platform today. */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { cycleRegion, installKeyboard, moveRegion, whichKey } from "../keyboard"
import { SEQUENCES, sequenceLabel, SHORTCUTS, shortcutLabel, type SequenceID, type ShortcutID } from "../shortcuts"
import "./keyboard-layer.css"
import { DESK } from "../desk-identity"
import { host } from "../host"
import { useDeskChatOptional } from "../desk-companion"
import { createHints, type Hint } from "../hints"

// The Work desk is shown as Porter; a Personal page keeps "Front desk". A host without a profile is Work.
const sequenceTitle = (id: SequenceID) =>
  id === "goDesk" && host()?.profile !== "personal" ? `Go to ${DESK.name}` : SEQUENCES[id].title

// Every key that opens this overlay is listed on its one row.
const HELP: ShortcutID[] = ["help", "helpF1"]

const GROUPS = [
  ["app", "Anywhere"],
  ["session", "Session"],
  ["composer", "Composer"],
  ["decision", "Decisions and forms"],
] as const

export function KeyboardLayer() {
  const navigate = useNavigate()
  const chat = useDeskChatOptional()
  const [open, setOpen] = createSignal(false)
  const [hints, setHints] = createSignal<{ list: Hint[]; typed: string }>()
  // Where ⌘/ came from, so a second ⌘/ goes back there; and whether it opened the pane, so going back closes it.
  let porterFrom: { el: HTMLElement | null; opened: boolean } | undefined
  const porterBox = () => document.querySelector<HTMLTextAreaElement>(".desk-companion:not(.closed) .prompt-box textarea")
  const porter = () => {
    if (!chat) return navigate("/")
    const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    if (active?.closest(".desk-companion")) {
      const back = porterFrom
      porterFrom = undefined
      if (back?.opened) chat.setOpen(false)
      // Entered by mouse: go to this page's own composer, if it has one.
      const main = [...document.querySelectorAll<HTMLElement>(".session-page")].find((el) => !el.closest(".desk-companion"))
      const target = back?.el?.isConnected ? back.el : main?.querySelector<HTMLElement>(".prompt-box textarea")
      return target ? target.focus() : active.blur()
    }
    porterFrom = { el: active, opened: !chat.open() }
    chat.setOpen(true)
    // The pane drops `inert` in an effect and may still be loading its conversation: focus its text box once it can
    // take focus (up to 1.5 s), else its first control (a desk that is not ready shows its start controls there).
    // Focus that moved elsewhere meanwhile stays where it went.
    const started = Date.now()
    const settle = () => {
      if (document.activeElement !== (active ?? document.body) && document.activeElement !== document.body) return
      const box = porterBox()
      if (box && !box.closest("[inert]")) return box.focus()
      if (Date.now() - started < 1500) return void setTimeout(settle, 50)
      document.querySelector<HTMLElement>(".desk-companion:not(.closed) button:not([disabled])")?.focus()
    }
    requestAnimationFrame(settle)
  }
  const hinting = createHints(hints, setHints)
  let invoker: HTMLElement | null = null
  const show = () => {
    invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    invoker?.focus()
  }
  onMount(() => {
    // Registered first, so while labels show it sees every key before the sequence layer.
    window.addEventListener("keydown", hinting.keydown, true)
    window.addEventListener("resize", hinting.cancel)
    window.addEventListener("scroll", hinting.cancel, true)
    onCleanup(() => {
      window.removeEventListener("keydown", hinting.keydown, true)
      window.removeEventListener("resize", hinting.cancel)
      window.removeEventListener("scroll", hinting.cancel, true)
    })
    onCleanup(
      installKeyboard({
        reference: show,
        referenceLeader: show,
        help: show,
        helpF1: show,
        porter,
        hints: hinting.start,
        hintsAll: hinting.startAll,
        goDesk: porter,
        goInbox: () => navigate("/"),
        goAgents: () => navigate("/agents"),
        goUsage: () => navigate("/usage"),
        goCloud: () => navigate("/cloud"),
        goNewSession: () => navigate("/new"),
        nextRegion: () => cycleRegion(1),
        previousRegion: () => cycleRegion(-1),
        focusLeft: () => moveRegion("left"),
        focusDown: () => moveRegion("down"),
        focusUp: () => moveRegion("up"),
        focusRight: () => moveRegion("right"),
      }),
    )
  })
  const chords = (where: string) =>
    (Object.keys(SHORTCUTS) as ShortcutID[]).filter((id) => SHORTCUTS[id].status === "dispatched" && SHORTCUTS[id].where === where && !HELP.includes(id))
  // Both "?" and "Space ?" open this overlay; list the pair once.
  const sequences = () =>
    (Object.keys(SEQUENCES) as SequenceID[]).filter((id) => SEQUENCES[id].status === "dispatched" && id !== "referenceLeader")
  return (
    <>
      <Show when={hints()}>
        {(state) => (
          <div class="kbd-hints" aria-hidden="true">
            <For each={state().list.filter((hint) => hint.label.startsWith(state().typed))}>
              {(hint) => (
                <span class="kbd-hint" dir="ltr" style={{ left: `${hint.x}px`, top: `${hint.y}px` }}>
                  <b>{state().typed}</b>{hint.label.slice(state().typed.length)}
                </span>
              )}
            </For>
          </div>
        )}
      </Show>
      <Show when={whichKey()}>
        {(state) => (
          <div class="kbd-which-key" role="status" aria-live="polite">
            <div class="kbd-which-key-prefix"><kbd dir="ltr">{state().prefix.join(" ")}</kbd> …</div>
            <For each={state().next}>
              {(entry) => <div><kbd dir="ltr">{entry.key}</kbd> <span dir="auto">{sequenceTitle(entry.id)}</span></div>}
            </For>
          </div>
        )}
      </Show>
      <Show when={open()}>
        <div class="kbd-overlay-backdrop" onClick={(event) => event.target === event.currentTarget && close()}>
          <div ref={(el) => queueMicrotask(() => el.focus())} class="kbd-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabIndex={-1}
            onKeyDown={(event) => {
              // Nothing inside is focusable; keep focus in the dialog until Esc.
              if (event.key === "Tab") event.preventDefault()
              if (event.key !== "Escape") return
              event.preventDefault()
              event.stopPropagation()
              close()
            }}>
            <h2>Keyboard shortcuts</h2>
            <For each={GROUPS}>
              {([where, title]) => (
                <section>
                  <h3>{title}</h3>
                  <dl>
                    <For each={chords(where)}>
                      {(id) => <div class="kbd-row"><dt><kbd dir="ltr">{shortcutLabel(id)}</kbd></dt><dd dir="auto">{SHORTCUTS[id].title}</dd></div>}
                    </For>
                    <Show when={where === "app"}>
                      <For each={sequences()}>
                        {(id) => (
                          <div class="kbd-row">
                            <dt><kbd dir="ltr">{sequenceLabel(id)}</kbd>{id === "reference" ? <> <kbd dir="ltr">{sequenceLabel("referenceLeader")}</kbd>
                              <For each={HELP}>{(help) => <> <kbd dir="ltr">{shortcutLabel(help)}</kbd></>}</For></> : null}</dt>
                            <dd dir="auto">{sequenceTitle(id)}</dd>
                          </div>
                        )}
                      </For>
                    </Show>
                  </dl>
                </section>
              )}
            </For>
            <p class="kbd-overlay-note">Letter keys and sequences work when focus is outside a text field. In a composer, Esc
              switches to Normal and Esc again moves to the transcript, keeping the draft; i returns to it. In a Surface
              reader its own letters (C, D, F, H, J, K, M, .) come first. Esc closes.</p>
          </div>
        </div>
      </Show>
    </>
  )
}
