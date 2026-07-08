// fork(session-umbrella): persistent session CWD in the session view.
// Extension-first: new feature-plugin registering into the (fork-added)
// session_prompt_footer_right host slot — bottom status line, next to
// tokens/cost. Upstream touched only at registration seams (builtins.ts,
// slot type in plugin/tui.ts, Slot render in prompt/index.tsx).
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import { abbreviateHome } from "../../runtime"
import { useTuiPaths } from "../../context/runtime"

const id = "fork:session-cwd"

const MAX_LENGTH = 48

function View(props: { api: TuiPluginApi; sessionID: string }) {
  const paths = useTuiPaths()
  const theme = () => props.api.theme.current
  const path = createMemo(() => {
    const session = props.api.state.session.get(props.sessionID)
    const dir = session?.directory
    if (!dir) return undefined
    let out = abbreviateHome(dir, paths.home)
    if (out.length > MAX_LENGTH) out = "…" + out.slice(-(MAX_LENGTH - 1))
    const list = out.split("/")
    return {
      parent: list.slice(0, -1).join("/"),
      name: list.at(-1) ?? "",
    }
  })

  return (
    <Show when={path()}>
      {(value) => (
        <text flexShrink={1} wrapMode="none">
          <span style={{ fg: theme().textMuted }}>{value().parent}/</span>
          <span style={{ fg: theme().text }}>{value().name}</span>
        </text>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      session_prompt_footer_right(_ctx, props) {
        return <View api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
