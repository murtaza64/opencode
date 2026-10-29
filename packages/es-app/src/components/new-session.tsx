/* New session: opens the draft page (/new) on the same frame; the session is
 * created by its first Send there, with agent, model and directory chosen in
 * place (dotfiles#240). */
import { Show } from "solid-js"
import { A } from "@solidjs/router"
import { Glyph } from "./icons"

export const NewSession = (props: { compact?: boolean; inline?: boolean }) =>
  <Show when={!props.inline} fallback={
    // In the Agents tab's control row: a small contextual action; the draft page chooses project and host as before.
    <A href="/new" activeClass="active" class="agent-filter agent-new" title="New session" aria-label="New session">
      <Glyph name="plus" /><span>New</span>
    </A>}>
    <div class="new-session" classList={{ "new-session-compact": props.compact }}>
      <A href="/new" activeClass="active" class={props.compact ? "mini-item new-session-button" : "new-session-button"}
        title="New session" aria-label="New session">
        <Glyph name="plus" /><span hidden={props.compact}>New session</span>
      </A>
    </div>
  </Show>
