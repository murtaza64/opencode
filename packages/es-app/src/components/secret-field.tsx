/* Masked fields for a secret decision option. Inputs are uncontrolled: values live only in the DOM
 * inputs until one POST, and are cleared on submit, unmount, a revision change or a hidden window. */
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import type { AttentionOption, AttentionRecord } from "../attention"
import { host } from "../host"
import { secretFieldAvailable, secretMissing, submitSecret, type SecretInput } from "../secret-field"

export const SecretField = (props: { id: string; record: AttentionRecord; option: AttentionOption; spec: SecretInput; disabled: boolean; onDelivered: () => void; send?: typeof fetch }) => {
  const inputs: Record<string, HTMLInputElement> = {}
  const [filled, setFilled] = createSignal<Record<string, boolean>>({})
  const [busy, setBusy] = createSignal(false)
  const [message, setMessage] = createSignal("")
  const [closed, setClosed] = createSignal(false)
  const clear = () => {
    for (const input of Object.values(inputs)) input.value = ""
    setFilled({})
  }
  const hidden = () => { if (document.visibilityState === "hidden") clear() }
  document.addEventListener("visibilitychange", hidden)
  onCleanup(() => { document.removeEventListener("visibilitychange", hidden); clear() })
  createEffect(on(() => props.record.revision, () => { clear(); setMessage(""); setClosed(false) }, { defer: true }))
  const missing = () => props.spec.fields.find(field => !filled()[field.id])?.label
  const submit = async () => {
    if (busy() || closed() || props.disabled) return
    const values = Object.fromEntries(props.spec.fields.map(field => [field.id, inputs[field.id]?.value ?? ""]))
    if (secretMissing(props.spec, values)) return
    setBusy(true)
    setMessage("")
    // Inputs empty before the request resolves, so nothing typed outlives this single submission.
    clear()
    const outcome = await submitSecret(props.record, props.option, props.spec, values, props.send)
    setBusy(false)
    if (outcome.ok) {
      setMessage("Handed to the approved program on this computer. Only a receipt was recorded; the agent checks the outcome.")
      setClosed(true)
      props.onDelivered()
      return
    }
    setMessage(outcome.message)
    setClosed(outcome.final)
  }
  return <Show when={secretFieldAvailable(window.location, host()?.remote === true)} fallback={
    <p class="home-input-problem" role="status" data-secret-unavailable>This asks for a secret. Answer it in the app on the computer that asked; it cannot be sent from here.</p>}>
    <fieldset class="home-input home-secret" data-kind="secret" disabled={props.disabled || busy() || closed()} aria-describedby={`${props.id}-secret-note`}>
      <legend dir="auto">{props.spec.label}</legend>
      <For each={props.spec.fields}>{field => <label class="home-secret-field">
        <span dir="auto">{field.label}</span>
        <input ref={element => { inputs[field.id] = element }} id={`${props.id}-${field.id}`} type="password" name={`secret-${field.id}`}
          autocomplete="off" autocapitalize="off" spellcheck={false} data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"
          onInput={event => setFilled(current => ({ ...current, [field.id]: !!event.currentTarget.value.trim() }))}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void submit() } }} />
      </label>}</For>
      <p class="home-muted" id={`${props.id}-secret-note`} dir="auto">
        <Show when={props.spec.hint} fallback="Sent once, directly to the approved program on this computer. It is not saved, shown to the agent or recorded.">{hint => hint()}</Show>
      </p>
      <div class="home-actions">
        <button type="button" class="home-primary" disabled={!!missing() || busy() || closed() || props.disabled} onClick={() => void submit()}>
          {busy() ? "Sending securely…" : "Submit securely"}
        </button>
        <Show when={missing() && !closed()}><span class="home-muted">Add {missing()!.toLowerCase()}</span></Show>
      </div>
    </fieldset>
    <Show when={message()}><p class="home-input-problem" role="status" dir="auto" data-secret-outcome>{message()}</p></Show>
  </Show>
}
