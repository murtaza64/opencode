import { Show } from "solid-js"
import { mailNamer, type MailNamer } from "../mail-names"
import { useDashboard } from "../state"

/** A mail sender or recipient: the agent's familiar name when verified, else the lane address. The tooltip keeps the lane and session; `detail` also prints the lane. */
export const MailParty = (props: { party: string; evidence?: string | null; name?: MailNamer; detail?: boolean }) => {
  const name = () => props.name?.(props.party, props.evidence) ?? { label: props.party, title: props.party, named: false }
  return <>
    <bdi dir="auto" class="mail-party" data-named={name().named ? "true" : undefined} data-lane={props.party} title={name().title}>{name().label}</bdi>
    <Show when={props.detail && name().named}> · lane <bdi dir="auto">{props.party}</bdi></Show>
  </>
}

/** Names mail parties in `editspace` from dashboard lane owners, handoff lineage and session titles. */
export const useMailNamer = (editspace: () => string | undefined) => {
  const dashboard = useDashboard()
  return mailNamer(() => {
    const name = editspace()
    return name ? {
      editspace: name,
      owners: dashboard.lineageOwners(),
      handoffs: dashboard.lineage(),
      title: (id) => dashboard.activity.session(id)?.title,
    } : undefined
  })
}
