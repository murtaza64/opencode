/* Where mail came from: Squadron (external workspace, through the local bridge)
 * or Electric Sheep (local agents, including other editspaces). Classified only
 * from structured fields: the bridge's principal plus its `squadron` metadata.
 * Mail from a party nothing identifies gets no label rather than a guess.
 * Display only: routing and authority are unchanged. */

/** The local bridge's mail identity (dotfiles es_squadron_lib PRINCIPAL). */
export const SQUADRON_BRIDGE = "integration:squadron"

export type SquadronMeta = {
  workspace_id?: string
  workspace_name?: string
  ui_url?: string
  persona?: string
  mode?: string
  items?: { kind?: string; persona?: string; actor_kind?: string; message_id?: string; document_id?: string; title?: string }[]
}

export type MailOrigin =
  | { kind: "squadron"; workspace?: string; workspaceID?: string; url?: string; actors: string[] }
  | { kind: "electric-sheep" }

const SESSION = /^ses_[\w-]+$/
const REMOTE = /^[^/\s]+\/[^/\s]+$/

/** The workspace link, only for an https duolingo.com origin as the bridge itself requires. */
const workspaceURL = (value: unknown) => {
  if (typeof value !== "string") return
  const url = URL.parse(value)
  if (!url || url.protocol !== "https:" || url.username || url.password) return
  return url.hostname === "duolingo.com" || url.hostname.endsWith(".duolingo.com") ? url.href : undefined
}

/**
 * `local(party)` says whether a bare name is a lane this client knows. Session ids,
 * operators and `<editspace>/<lane>` addresses are local by their shape.
 */
export const mailOrigin = (from: string, squadron: SquadronMeta | undefined, local: (party: string) => boolean): MailOrigin | undefined => {
  if (from === SQUADRON_BRIDGE) {
    const meta = squadron && typeof squadron === "object" ? squadron : undefined
    // The people or agents who wrote in the workspace; the bridge only carried their events.
    const actors = [...new Set((meta?.items ?? []).flatMap((item) =>
      item && typeof item.persona === "string" && item.persona && item.kind?.startsWith("message.") ? [item.persona] : []))]
    return {
      kind: "squadron",
      ...(typeof meta?.workspace_name === "string" && meta.workspace_name ? { workspace: meta.workspace_name } : {}),
      ...(typeof meta?.workspace_id === "string" ? { workspaceID: meta.workspace_id } : {}),
      ...(workspaceURL(meta?.ui_url) ? { url: workspaceURL(meta?.ui_url) } : {}),
      actors,
    }
  }
  if (SESSION.test(from) || from === "orchestrator" || from === "human" || REMOTE.test(from) || local(from))
    return { kind: "electric-sheep" }
  return undefined
}

export const originLabel = (origin: MailOrigin) => origin.kind === "squadron" ? "Squadron" : "Electric Sheep"

/** The sender as people know it: the workspace author(s), never the bridge. */
export const squadronSender = (origin: Extract<MailOrigin, { kind: "squadron" }>) =>
  origin.actors.length ? `${origin.actors[0]}${origin.actors.length > 1 ? ` +${origin.actors.length - 1}` : ""}`
    : origin.workspace ?? "Squadron workspace"
