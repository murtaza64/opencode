import { createMemo, Show } from "solid-js"
import { Glyph } from "./icons"
import { laterTick, transcriptTick, type Tick } from "../message-ticks"

const GLYPH = { sending: "clock", sent: "check", delivered: "check-double", read: "check-double", failed: "alert" } as const

/** One message's tick (DOUBLE-TICK): a small glyph on the trailing side; the hover title and accessible name give
 * the exact state and time. `mail` draws it in the mail colour. */
export const TickMark = (props: { tick: Tick; label: string; mail?: boolean }) =>
  // An <i>, not a <span>: rows address their text spans directly (e.g. `.outgoing-cue > span`).
  <i class="msg-tick" data-tick={props.tick} data-mail={props.mail ? "" : undefined} role="img" aria-label={props.label} title={props.label}>
    <Glyph name={GLYPH[props.tick]} size={12} />
  </i>

/** A promoted user message: delivered, then read once a turn started after its promotion. Never steps back. */
export const DeliveredTick = (props: { promotedAt: number; turnStarted?: number }) => {
  const value = createMemo<ReturnType<typeof transcriptTick> | undefined>((previous) => {
    const next = transcriptTick(props)
    return previous && laterTick(previous.tick, next.tick) === previous.tick && previous.tick !== next.tick ? previous : next
  })
  return <Show when={value()}>{(tick) => <div class="msg-tick-row"><TickMark tick={tick().tick} label={tick().label} /></div>}</Show>
}
