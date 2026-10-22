/* New session: opens the draft page (/new) on the same frame; the session is
 * created by its first Send there, with agent, model and directory chosen in
 * place (dotfiles#240). */
import { A } from "@solidjs/router"
import { Glyph } from "./icons"

export const NewSession = (props: { compact?: boolean }) =>
  <div class="new-session" classList={{ "new-session-compact": props.compact }}>
    <A href="/new" activeClass="active" class={props.compact ? "mini-item new-session-button" : "new-session-button"}
      title="New session" aria-label="New session">
      <Glyph name="plus" /><span hidden={props.compact}>New session</span>
    </A>
  </div>
