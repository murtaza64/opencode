import type { ComposerAction, InputReceipt } from "./composer"

// The composer's one primary action (button and Cmd/Ctrl+Enter), from the current draft and the
// Core-confirmed pending inputs. A draft with text or images always sends. An empty draft acts on
// what is already waiting: a pending steer is delivered now, otherwise the agent is nudged through
// Core's explicit continuation once it exists. An empty draft never sends an empty or synthesized
// prompt, and never nudges over a send whose outcome is still unknown.
export type PrimaryAction =
  | { kind: "send"; action: ComposerAction }
  | { kind: "deliver"; requestID: string }
  | { kind: "nudge" }

/** `name` is the accessible name: the visible label plus what it acts on, distinct from the session-action Nudge. */
export type PrimaryResolution = PrimaryAction & { label: string; name?: string; title: string; disabled?: string }

export const primaryAction = (input: {
  hasContent: boolean
  busy: boolean
  keyboardTarget: ComposerAction
  receipts: readonly InputReceipt[]
  /** Core can interrupt the running turn and deliver a pending steer (`sessionInput.interrupt`). */
  interrupt: boolean
  delivering: string | null
  /** Core can explicitly continue an idle session with nothing pending (capability not shipped yet). */
  nudge: boolean
  /** An input admission or plain send has no confirmed outcome yet, or is still in flight. */
  unsettled: boolean
  nudging: boolean
}): PrimaryResolution => {
  if (input.hasContent) {
    const action = input.busy ? input.keyboardTarget : "steer"
    return { kind: "send", action, label: input.busy ? action[0]!.toUpperCase() + action.slice(1) : "Send", title: "" }
  }
  const nudge = { kind: "nudge" as const, label: input.nudging ? "Nudging…" : "Nudge", name: "Nudge the agent (empty message)",
    title: "Empty message: interrupt, then send a resume message" }
  if (input.nudging) return { ...nudge, disabled: "A nudge is already running." }
  // Only the human's own inputs that Core confirmed pending; agent mail is never the human's to deliver.
  const pending = input.receipts.filter((receipt) => receipt.state === "pending" && receipt.source?.type !== "editspace-mail")
  const steer = pending.filter((receipt) => receipt.delivery === "steer").toSorted((a, b) => a.admittedSeq - b.admittedSeq)[0]
  const deliverLabel = input.busy ? "Interrupt & steer now" : "Steer now"
  const deliverName = `${deliverLabel} with your pending steer`
  if (input.delivering)
    return { kind: "deliver", requestID: input.delivering, label: "Steering…", title: "Interrupt and deliver in progress.", disabled: "Interrupt and deliver in progress." }
  if (steer) {
    const title = input.busy
      ? "Stops the current reply (its output so far is kept) and starts the next turn with your pending steer. Nothing is rerun."
      : "Starts a turn with your pending steer."
    if (!input.interrupt) return { kind: "deliver", requestID: steer.requestID, label: deliverLabel, name: deliverName, title,
      disabled: "This agent runtime cannot deliver a pending steer early. It is delivered at the next safe point." }
    return { kind: "deliver", requestID: steer.requestID, label: deliverLabel, name: deliverName, title }
  }
  if (input.unsettled) return { ...nudge, disabled: "Your last message is not confirmed yet. Check it before nudging." }
  if (pending.length) return { ...nudge, disabled: "A queued input is waiting for this task. Edit it to Steer to deliver it now." }
  // Without Core's explicit continuation an empty Nudge would be a no-op or a synthesized prompt; neither is a nudge.
  if (!input.nudge) return { ...nudge, disabled: "Nudge is not available on this agent runtime yet. Type a message to continue." }
  return nudge
}
