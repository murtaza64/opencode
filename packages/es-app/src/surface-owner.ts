import type { Surface } from "./surfaces"

export type Owner = { state: "ok"; session: string; directory: string; busy?: boolean } | { state: "none" | "unknown"; why: string }

/** The current owner of the lane that published `surface`, read from that host's dashboard (`prefix` "" for this host,
 * `/hosts/<id>` for another Work host): exactly one lane record naming a session that host still lists. */
export const surfaceOwner = async (surface: Pick<Surface, "lane" | "editspace">, prefix: string): Promise<Owner> => {
  if (!surface.lane) return { state: "none", why: "no owning lane recorded" }
  const response = await fetch(`${prefix}/es/api/state?es=${encodeURIComponent(surface.editspace)}`, { cache: "no-store" }).catch(() => undefined)
  if (!response?.ok || !response.headers.get("content-type")?.includes("application/json")) return { state: "unknown", why: "owner not readable now" }
  // The dashboard's real shape (es-dashboard assemble()): lane records sit on the cards that show them,
  // threads[].lanes[] {lane, owner, ...}; sessions both at the top level and on each card, each with its directory.
  // A top-level `lanes` list, if a dashboard serves one, is read too.
  type Lane = { lane?: string; owner?: string }
  type Row = { id?: string; directory?: string; live?: string }
  const body = await response.json().catch(() => undefined) as { threads?: { lanes?: Lane[]; sessions?: Row[] }[]; lanes?: Lane[]; sessions?: Row[] } | undefined
  const threads = Array.isArray(body?.threads) ? body.threads : []
  const records = [...threads.flatMap((thread) => Array.isArray(thread.lanes) ? thread.lanes : []), ...(Array.isArray(body?.lanes) ? body.lanes : [])]
  const lanes = new Map(records.filter((lane) => lane?.lane === surface.lane).map((lane) => [lane.owner ?? "", lane]))
  // A lane shows on a card only while its owner session is listed there (or it carries tickets), so an absent lane
  // is unknown on this read, not proof that the lane does not exist.
  if (!lanes.size) return { state: "unknown", why: `owner of ${surface.lane} not listed on that host now` }
  if (lanes.size > 1) return { state: "unknown", why: "owner ambiguous" }
  const owner = [...lanes.keys()][0]
  const sessions = [...(Array.isArray(body?.sessions) ? body.sessions : []), ...threads.flatMap((thread) => Array.isArray(thread.sessions) ? thread.sessions : [])]
  const session = owner ? sessions.find((item) => item?.id === owner && typeof item.directory === "string" && item.directory) : undefined
  if (!owner || !session?.directory) return { state: "none", why: "no current owner session" }
  return { state: "ok", session: owner, directory: session.directory, busy: session.live === "busy" || session.live === "retry" }
}
