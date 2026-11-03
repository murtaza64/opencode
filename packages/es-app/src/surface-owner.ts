import type { Surface } from "./surfaces"

export type Owner = { state: "ok"; session: string; directory: string } | { state: "none" | "unknown"; why: string }

/** The current owner of the lane that published `surface`, read from that host's dashboard (`prefix` "" for this host,
 * `/hosts/<id>` for another Work host): exactly one lane record naming a session that host still lists. */
export const surfaceOwner = async (surface: Pick<Surface, "lane" | "editspace">, prefix: string): Promise<Owner> => {
  if (!surface.lane) return { state: "none", why: "no owning lane recorded" }
  const response = await fetch(`${prefix}/es/api/state?es=${encodeURIComponent(surface.editspace)}`, { cache: "no-store" }).catch(() => undefined)
  if (!response?.ok || !response.headers.get("content-type")?.includes("application/json")) return { state: "unknown", why: "owner not readable now" }
  const body = await response.json().catch(() => undefined) as {
    threads?: { lanes?: { lane: string; owner?: string }[] }[]; sessions?: { id: string; directory?: string }[]
  } | undefined
  const lanes = new Map((body?.threads ?? []).flatMap((thread) => thread.lanes ?? []).filter((lane) => lane.lane === surface.lane).map((lane) => [lane.owner ?? "", lane]))
  if (!lanes.size) return { state: "none", why: `lane ${surface.lane} not found` }
  if (lanes.size > 1) return { state: "unknown", why: "owner ambiguous" }
  const owner = [...lanes.keys()][0]
  const session = owner ? body?.sessions?.find((item) => item.id === owner) : undefined
  if (!owner || !session?.directory) return { state: "none", why: "no current owner session" }
  return { state: "ok", session: owner, directory: session.directory }
}

