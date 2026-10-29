/* Mounts app-wide keyboard dispatch, the which-key popup and the "?" shortcut
 * overlay. The overlay lists only dispatched registry bindings, so every row is a
 * key that works on this platform today. */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { cycleRegion, installKeyboard, moveRegion, whichKey } from "../keyboard"
import { SEQUENCES, sequenceLabel, SHORTCUTS, shortcutLabel, type SequenceID, type ShortcutID } from "../shortcuts"
import "./keyboard-layer.css"

const GROUPS = [
  ["app", "Anywhere"],
  ["session", "Session"],
  ["composer", "Composer"],
  ["decision", "Decisions and forms"],
] as const

export function KeyboardLayer() {
  const navigate = useNavigate()
  const [open, setOpen] = createSignal(false)
  let invoker: HTMLElement | null = null
  const show = () => {
    invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    invoker?.focus()
  }
  onMount(() =>
    onCleanup(
      installKeyboard({
        reference: show,
        referenceLeader: show,
        goDesk: () => navigate("/"),
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
    ),
  )
  const chords = (where: string) =>
    (Object.keys(SHORTCUTS) as ShortcutID[]).filter((id) => SHORTCUTS[id].status === "dispatched" && SHORTCUTS[id].where === where)
  // Both "?" and "Space ?" open this overlay; list the pair once.
  const sequences = () =>
    (Object.keys(SEQUENCES) as SequenceID[]).filter((id) => SEQUENCES[id].status === "dispatched" && id !== "referenceLeader")
  return (
    <>
      <Show when={whichKey()}>
        {(state) => (
          <div class="kbd-which-key" role="status" aria-live="polite">
            <div class="kbd-which-key-prefix"><kbd dir="ltr">{state().prefix.join(" ")}</kbd> …</div>
            <For each={state().next}>
              {(entry) => <div><kbd dir="ltr">{entry.key}</kbd> <span dir="auto">{SEQUENCES[entry.id].title}</span></div>}
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
                            <dt><kbd dir="ltr">{sequenceLabel(id)}</kbd>{id === "reference" ? <> <kbd dir="ltr">{sequenceLabel("referenceLeader")}</kbd></> : null}</dt>
                            <dd dir="auto">{SEQUENCES[id].title}</dd>
                          </div>
                        )}
                      </For>
                    </Show>
                  </dl>
                </section>
              )}
            </For>
            <p class="kbd-overlay-note">Letter keys and sequences work when focus is outside a text field. Esc closes.</p>
          </div>
        </div>
      </Show>
    </>
  )
}
