import { createMemo, Show } from "solid-js"
import { A, useSearchParams } from "@solidjs/router"
import { AppHeader } from "../components/native-header"
import { CloudAgentDetails } from "../home-cloud-agents"
import { useDashboard } from "../state"
import "./home.css"

export default function CloudPage() {
  const [params] = useSearchParams()
  const cloud = useDashboard().cloud
  const pin = createMemo(() => typeof params.es === "string" && typeof params.lane === "string" && typeof params.owner === "string" && params.es && params.lane && params.owner
    ? { editspace: params.es, lane: params.lane, owner: params.owner } : undefined)
  return <main class="attention-home"><AppHeader><h1>Cloud agent</h1><A href="/">Home</A><span class="home-header-end home-muted">Wingman · read-only</span></AppHeader>
    <Show when={pin()} fallback={<p class="home-warning">Cloud link is incomplete. No local session was opened.</p>}>{value => <><div class="home-section"><h2><bdi dir="auto">{value().lane}</bdi></h2><button disabled={cloud.loading()} onClick={() => cloud.refresh([value().editspace])}>Refresh cloud source</button></div><CloudAgentDetails pin={value()} /></>}</Show>
  </main>
}
