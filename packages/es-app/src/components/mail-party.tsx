import { Show } from "solid-js"
import { mailNamer, type MailNamer } from "../mail-names"
import { useDashboard } from "../state"
import { agentIdentity, agentLabel } from "../agent-identity"

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
  const base = mailNamer(() => {
    const name = editspace()
    return name ? {
      editspace: name,
      owners: dashboard.lineageOwners(),
      handoffs: dashboard.lineage(),
      title: (id) => dashboard.activity.session(id)?.title,
    } : undefined
  })
  // A lane's stable identity (project/lane, alias when registered) leads; a raw session keeps its recorded title.
  const named = ((party: string, evidence?: string | null) => {
    const original = base(party, evidence)
    if (party === "human" || /^ses_[\w-]+$/.test(party)) {
      const desk = agentIdentity({ session: party, title: original.label })
      return desk.key === "desk" ? { ...original, label: desk.alias ?? desk.primary, named: true } : original
    }
    const identity = agentIdentity({ owner: party, editspace: editspace() })
    // The same resolver: a registered alias is the row name; otherwise project/lane. The full label is the tooltip.
    return { label: identity.alias ?? identity.primary, title: identity.alias ? agentLabel(identity) : original.title, named: true }
  }) as ReturnType<typeof mailNamer>
  named.local = base.local
  return named
}
