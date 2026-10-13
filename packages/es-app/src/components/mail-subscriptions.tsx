import { createResource, createSignal, For, Show } from "solid-js"
import { es, type MailSubscription } from "../api"

export const MailSubscriptions = (props: { editspace: string; recipient: string }) => {
  const [subscriptions, { refetch }] = createResource(
    () => [props.editspace, props.recipient] as const,
    ([name, recipient]) => es.subscriptions(name, recipient),
  )
  const [selector, setSelector] = createSignal("direct")
  const [sender, setSender] = createSignal("*")
  const [kind, setKind] = createSignal("*")
  const [mode, setMode] = createSignal<MailSubscription["mode"]>("actionable")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const change = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError("")
    try {
      await work()
      await refetch()
    } catch (failure) {
      setError(`Subscription update failed: ${String(failure)}`)
    } finally {
      setBusy(false)
    }
  }
  return <section class="mail-subscriptions" aria-label="Mail subscriptions">
    <div class="banner-head">Mail subscriptions · {props.recipient}</div>
    <Show when={subscriptions.error}><div class="err" role="alert">Unable to load subscriptions: {String(subscriptions.error)}</div></Show>
    <Show when={error()}><div class="err" role="alert">{error()}</div></Show>
    <For each={subscriptions()?.subscriptions ?? []}>{(item) => <div class="mail-subscription">
      <span>{item.selector} · from {item.sender} · {item.kind}</span>
      <select aria-label={`Delivery for ${item.selector} from ${item.sender}`} value={item.mode} disabled={busy()}
        onChange={(event) => void change(() => es.setSubscription(props.editspace, props.recipient,
          { ...item, mode: event.currentTarget.value as MailSubscription["mode"] }))}>
        <option value="actionable">Actionable</option><option value="passive">Passive</option><option value="mute">Mute</option>
      </select>
      <button disabled={busy()} onClick={() => void change(() => es.removeSubscription(props.editspace, props.recipient, item))}>Remove</button>
    </div>}</For>
    <div class="mail-subscription">
      <input aria-label="Mail selector" list="mail-selectors" value={selector()} onInput={(event) => setSelector(event.currentTarget.value)} />
      <datalist id="mail-selectors"><option value="direct" /><option value="project" /><option value="subtree" /><option value="issue:" /><option value="topic:" /></datalist>
      <input aria-label="Sender filter" value={sender()} onInput={(event) => setSender(event.currentTarget.value)} />
      <input aria-label="Kind filter" value={kind()} onInput={(event) => setKind(event.currentTarget.value)} />
      <select aria-label="Delivery mode" value={mode()} onChange={(event) => setMode(event.currentTarget.value as MailSubscription["mode"])}>
        <option value="actionable">Actionable</option><option value="passive">Passive</option><option value="mute">Mute</option>
      </select>
      <button disabled={busy() || !selector().trim()} onClick={() => void change(() => es.setSubscription(props.editspace, props.recipient,
        { selector: selector().trim(), sender: sender().trim() || "*", kind: kind().trim() || "*", mode: mode() }))}>Add</button>
    </div>
  </section>
}
