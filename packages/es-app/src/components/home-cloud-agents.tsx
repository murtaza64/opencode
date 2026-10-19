import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { ApiStatusError, es as esApi, type WingmanLane, type WingmanTranscript } from "../api"
import { cloudPins, isCloudPinned, toggleCloudPin } from "../cloud-pins"
import { linkUrl } from "../link-url"
import { ago } from "../state"
import { wingmanPrs, wingmanRunUrl, wingmanStatus, wingmanSyncedAt } from "../wingman"
import "./home-cloud-agents.css"

const POLL_MS = 30_000

type CloudState =
  | { kind: "absent" }
  | { kind: "error"; message: string }
  | { kind: "ok"; lanes: WingmanLane[]; error: string }

// Explicitly pinned Wingman lanes for one editspace. Renders nothing when the
// dashboard predates the cloud API, so older deployments degrade silently.
export default function HomeCloudAgents(props: { editspace?: string }) {
  const [data, { refetch }] = createResource(() => props.editspace ?? "", loadCloud)
  const timer = setInterval(() => void refetch(), POLL_MS)
  onCleanup(() => clearInterval(timer))
  const [showAvailable, setShowAvailable] = createSignal(false)

  const ready = () => {
    const value = data.latest
    return value?.kind === "ok" ? value : undefined
  }
  const pinned = () => {
    const value = ready()
    if (!value) return []
    const wanted = cloudPins().filter((pin) => pin.editspace === props.editspace).map((pin) => pin.lane)
    return wanted.map((lane) => value.lanes.find((row) => row.lane === lane) ?? { lane, status: "missing" })
  }
  const available = () => (ready()?.lanes ?? []).filter((row) => row.lane && !isPinned(props.editspace, row.lane))

  return (
    <Show when={data.latest && data.latest.kind !== "absent" && props.editspace}>
      <section class="home-cloud" aria-label="Pinned cloud agents">
        <header class="home-cloud-head">
          <h2>Cloud agents</h2>
          <Show when={(ready()?.lanes.length ?? 0) > 0}>
            <button type="button" class="home-cloud-toggle" onClick={() => setShowAvailable(!showAvailable())}>
              {showAvailable() ? "hide" : `pin… (${available().length})`}
            </button>
          </Show>
        </header>
        <Show when={data.latest?.kind === "error" ? data.latest : undefined}>
          {(failure) => <div class="home-cloud-error" role="status">Cloud lanes unavailable: {failure().message}</div>}
        </Show>
        <Show when={ready()?.error}>
          {(message) => <div class="home-cloud-error" role="status">Last Wingman sync failed: {message()}</div>}
        </Show>
        <Show when={ready() && pinned().length === 0 && !showAvailable()}>
          <div class="dim">
            {(ready()?.lanes.length ?? 0) > 0 ? "No pinned cloud agents." : "No Wingman lanes in this editspace."}
          </div>
        </Show>
        <For each={pinned()}>{(row) => <CloudRow editspace={props.editspace!} row={row} />}</For>
        <Show when={showAvailable()}>
          <div class="home-cloud-available">
            <For each={available()} fallback={<div class="dim">Every Wingman lane is pinned.</div>}>
              {(row) => (
                <div class="home-cloud-candidate">
                  <bdi dir="auto">{row.lane}</bdi>
                  <span class={`chip ${wingmanStatus(row["wingman-status"]).chip}`}>{wingmanStatus(row["wingman-status"]).label}</span>
                  <button type="button" onClick={() => toggleCloudPin({ runtime: "wingman", editspace: props.editspace!, lane: row.lane! })}>pin</button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
    </Show>
  )
}

function CloudRow(props: { editspace: string; row: WingmanLane }) {
  const [open, setOpen] = createSignal(false)
  const [transcript] = createResource(() => (open() ? props.row.lane : undefined), (lane) => loadTranscript(lane, props.editspace))
  const status = () => props.row.status === "missing"
    ? { label: "not found", chip: "failing" }
    : wingmanStatus(props.row["wingman-status"])
  const synced = () => wingmanSyncedAt(props.row)

  return (
    <article class="home-cloud-row">
      <div class="home-cloud-line">
        <strong><bdi dir="auto">{props.row.lane}</bdi></strong>
        <span class="chip">Wingman</span>
        <span class={`chip ${status().chip}`}>{status().label}</span>
        <Show when={props.row["wingman-repos"]}><span class="dim"><bdi dir="auto">{props.row["wingman-repos"]}</bdi></span></Show>
        <span class="home-cloud-spacer" />
        <button type="button" class="home-cloud-unpin" title="Unpin"
          onClick={() => toggleCloudPin({ runtime: "wingman", editspace: props.editspace, lane: props.row.lane! })}>unpin</button>
      </div>
      <Show when={props.row.status === "missing"}>
        <div class="home-cloud-error">The lane is gone or no longer a Wingman lane.</div>
      </Show>
      <Show when={props.row.activity}>
        <div class="home-cloud-activity" title={props.row.activity}><bdi dir="auto">{props.row.activity}</bdi></div>
      </Show>
      <Show when={props.row["wingman-error"]}>
        <div class="home-cloud-error"><bdi dir="auto">{props.row["wingman-error"]}</bdi></div>
      </Show>
      <div class="home-cloud-meta">
        <Show when={props.row["wingman-turns"]}><span>{props.row["wingman-turns"]} turns</span></Show>
        <Show when={props.row["wingman-cost"]}><span>${props.row["wingman-cost"]}</span></Show>
        <Show when={props.row["wingman-ci"]}><span>CI {props.row["wingman-ci"]}</span></Show>
        <span title="time since es last synced this lane from Wingman">{synced() ? `synced ${ago(synced())}` : "not synced yet"}</span>
        <For each={wingmanPrs(props.row["wingman-prs"])}>
          {(url, index) => <a href={linkUrl(url)} target="_blank" rel="noopener noreferrer" title={url}>PR {index() + 1}</a>}
        </For>
        <Show when={wingmanRunUrl(props.row)}>
          {(url) => <a href={url()} target="_blank" rel="noopener noreferrer">Temporal run</a>}
        </Show>
        <Show when={props.row.status !== "missing"}>
          <button type="button" class="home-cloud-link" onClick={() => setOpen(!open())}>{open() ? "hide transcript" : "transcript"}</button>
        </Show>
      </div>
      <Show when={open()}>
        <div class="home-cloud-transcript">
          <Show when={!transcript.loading} fallback={<div class="dim">Loading transcript from Wingman…</div>}>
            <Show when={transcript.error} fallback={<TranscriptTurns transcript={transcript()} />}>
              <div class="home-cloud-error">Transcript unavailable: {String(transcript.error?.message ?? transcript.error)}</div>
            </Show>
          </Show>
        </div>
      </Show>
    </article>
  )
}

function TranscriptTurns(props: { transcript?: WingmanTranscript }) {
  return (
    <For each={props.transcript?.turns ?? []} fallback={<div class="dim">No turns recorded.</div>}>
      {(turn, index) => (
        <div class="home-cloud-turn">
          <div class="dim">turn {index() + 1}{turn.status ? ` · ${turn.status}` : ""}</div>
          <div class="home-cloud-prompt"><bdi dir="auto">{(turn.prompt ?? "").trim().slice(0, 400)}</bdi></div>
          <Show when={turn.reply}><div><bdi dir="auto">{(turn.reply ?? "").trim().slice(0, 1200)}</bdi></div></Show>
        </div>
      )}
    </For>
  )
}

const isPinned = (editspace: string | undefined, lane: string) =>
  !!editspace && isCloudPinned({ runtime: "wingman", editspace, lane })

const loadCloud = async (editspace: string): Promise<CloudState> => {
  if (!editspace) return { kind: "absent" }
  try {
    const value = await esApi.wingman(editspace)
    return { kind: "ok", lanes: value.lanes ?? [], error: value.error ?? "" }
  } catch (error) {
    if (error instanceof ApiStatusError && error.routeMissing) return { kind: "absent" }
    return { kind: "error", message: error instanceof Error ? error.message : String(error) }
  }
}

const loadTranscript = (lane: string, editspace: string) => esApi.wingmanTranscript(lane, editspace)
