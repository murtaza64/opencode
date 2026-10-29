/* What's new (META-08): shown once per native app release after startup, only when it would not interrupt (no
 * focused editor with text unless input has paused, no focused permission or question); dismissing marks it seen.
 * The "What's new" entry reopens it any time and never re-marks. */
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { A } from "@solidjs/router"
import { markReleaseNotesSeen, readReleaseNotes } from "../release-notes"
import { useDashboard } from "../state"
import "./whats-new.css"

const IDLE_MS = 3000

export const WhatsNew = () => {
  const dashboard = useDashboard()
  const [state] = createResource(readReleaseNotes)
  const [open, setOpen] = createSignal(false)
  let dialog: HTMLDialogElement | undefined
  let returnTo: Element | null = null
  let autoShown = false
  let marked = false
  let lastInput = Date.now()
  const show = () => {
    if (!dialog || dialog.open) return
    returnTo = document.activeElement
    setOpen(true)
    dialog.showModal()
  }
  // A focused editor with text, or a focused permission/question, is someone mid-task: wait.
  const busy = () => {
    const active = document.activeElement
    if (active?.closest(".home-request, .home-permission, .inline-question, [data-request-id]")) return true
    const typing = active instanceof HTMLTextAreaElement && active.value.trim() !== ""
    return typing && Date.now() - lastInput < IDLE_MS
  }
  onMount(() => {
    const input = () => { lastInput = Date.now() }
    window.addEventListener("input", input, true)
    window.addEventListener("keydown", input, true)
    const timer = setInterval(() => {
      const current = state()
      // Startup-ready: the dashboard has answered once.
      if (autoShown || !current?.notes || current.seen || !dashboard.state()) return
      if (busy()) return
      autoShown = true
      show()
    }, 1000)
    onCleanup(() => { clearInterval(timer); window.removeEventListener("input", input, true); window.removeEventListener("keydown", input, true) })
  })
  const close = () => dialog?.close()
  const onClose = () => {
    setOpen(false)
    const current = state()
    if (current?.notes && !current.seen && current.release && !marked) { marked = true; void markReleaseNotesSeen(current.release) }
    if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus({ preventScroll: true })
  }
  return <>
    <button type="button" class="link-button whats-new-entry" onClick={show}>What's new</button>
    <dialog ref={dialog} class="whats-new" aria-labelledby="whats-new-title" onClose={onClose}>
      <Show when={open()}>
        <header class="whats-new-head">
          <h2 id="whats-new-title">What's new</h2>
          <Show when={state()?.release}>{release => <span class="whats-new-release" title="This app build"><bdi dir="ltr">{release()}</bdi></span>}</Show>
        </header>
        <Show when={state()?.notes} fallback={<p class="whats-new-empty" dir="auto">No notes for this release.</p>}>{notes => <>
          <ul class="whats-new-items">
            <For each={notes().items}>{item => <li>
              <strong dir="auto">{item.title}</strong>
              <Show when={item.detail}>{detail => <p dir="auto">{detail()}</p>}</Show>
              <Show when={item.try}>{link => <Show when={link().internal} fallback={
                <a class="whats-new-try" href={link().href} target="_blank" rel="noopener noreferrer">{link().label}</a>}>
                <A class="whats-new-try" href={link().href} onClick={close}>{link().label}</A>
              </Show>}</Show>
            </li>}</For>
          </ul>
          <Show when={notes().limits.length}>
            <h3>Known limits</h3>
            <ul class="whats-new-limits"><For each={notes().limits}>{limit => <li dir="auto">{limit}</li>}</For></ul>
          </Show>
        </>}</Show>
        <div class="whats-new-actions"><button type="button" class="home-primary" onClick={close} autofocus>Got it</button></div>
      </Show>
    </dialog>
  </>
}
