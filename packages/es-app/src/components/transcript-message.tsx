import { createMemo, createSignal, Show, type ComponentProps } from "solid-js"
import { Message } from "@opencode-ai/session-ui/message-part"

export const TranscriptMessage = (props: ComponentProps<typeof Message>) => {
  const generated = createMemo(() => {
    if (props.message.role !== "user" || !props.parts.length ||
      !props.parts.every(part => part.type === "text" && part.synthetic === true)) return ""
    return props.parts.flatMap(part => part.type === "text" && !part.ignored && part.text.trim() ? [part.text] : []).join("\n\n")
  })
  const [open, setOpen] = createSignal(false)
  const [copyState, setCopyState] = createSignal("Copy")
  const copy = async (event: MouseEvent & { currentTarget: HTMLButtonElement }) => {
    const input = document.createElement("textarea")
    input.value = generated()
    input.readOnly = true
    input.tabIndex = -1
    input.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none"
    event.currentTarget.closest("details")!.append(input)
    input.select()
    const copied = document.execCommand("copy")
    input.remove()
    event.currentTarget.focus({ preventScroll: true })
    const result = copied || await navigator.clipboard?.writeText(generated()).then(() => true, () => false)
    setCopyState(result ? "Copied" : "Copy failed")
  }
  return <Show when={generated()} fallback={<Message {...props} activityRows />}>
    <details class="generated-input" data-generated-message-id={props.message.id} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary class="activity-row">
        <span class="activity-kind">Generated input</span>
        <span class="activity-description" dir="auto">{generated().replace(/\s+/g, " ").trim().slice(0, 200)}</span>
        <span class="activity-disclosure" aria-hidden="true">›</span>
      </summary>
      <Show when={open()}>
        <div class="activity-details">
          <div class="activity-detail-actions"><button onClick={copy} aria-label="Copy generated input">{copyState()}</button></div>
          <div class="generated-input-body" dir="auto" tabIndex={0} role="region" aria-label="Generated input text">{generated()}</div>
        </div>
      </Show>
    </details>
  </Show>
}
