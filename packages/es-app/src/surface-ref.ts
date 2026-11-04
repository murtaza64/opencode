/* The one citable Surface reference (DD #740). An agent cites what `es surface publish`/`verify` returned:
 *
 *   ref:  <host>~surface:<id>[@r<N>]      (`surface:<id>` on a single-host setup; no @r = latest revision)
 *   cite: [<title>](/?item=<host>~surface%3A<id>[&rev=<N>])
 *
 * and each app resolves it to its own navigation: on the owning host it opens locally, elsewhere through that Work
 * host. Nothing here substitutes another host's or another revision's copy. */

export const SURFACE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
export const HOST_ID = /^[a-z][a-z0-9-]{0,31}$/
const TOKEN = /^(?:([a-z][a-z0-9-]{0,31})~)?surface:([a-z0-9][a-z0-9-]{0,39})(?:@r([1-9][0-9]{0,8}))?$/

export type SurfaceRef = { host?: string; id: string; revision?: number }

/** `<host>~surface:<id>[@r<N>]`, or undefined for anything else (whitespace, uppercase, other kinds, r0). */
export const parseSurfaceRef = (token: string): SurfaceRef | undefined => {
  const match = TOKEN.exec(token)
  if (!match) return
  return { ...(match[1] ? { host: match[1] } : {}), id: match[2]!, ...(match[3] ? { revision: Number(match[3]) } : {}) }
}

export const formatSurfaceRef = (ref: SurfaceRef) => `${ref.host ? `${ref.host}~` : ""}surface:${ref.id}${ref.revision ? `@r${ref.revision}` : ""}`

/** The app route a cite link points at. */
export const surfaceRefHref = (ref: SurfaceRef) =>
  `/?item=${encodeURIComponent(formatSurfaceRef({ host: ref.host, id: ref.id }))}${ref.revision ? `&rev=${ref.revision}` : ""}`

/** The ref an app route names (`/?item=<host>~surface%3A<id>[&rev=N]`, or the older `/?surface=<id>`), or undefined. */
export const surfaceRefFromRoute = (item: string | undefined, surface: string | undefined, rev: string | undefined): SurfaceRef | undefined => {
  const ref = surface !== undefined ? (SURFACE_ID.test(surface) ? { id: surface } : undefined) : item !== undefined ? parseSurfaceRef(item) : undefined
  if (!ref) return
  const revision = rev !== undefined && /^[1-9][0-9]{0,8}$/.test(rev) ? Number(rev) : undefined
  return { ...ref, ...(revision ? { revision } : {}) }
}

/** A work key naming this host (`<own>~…`) opens as this host's own item; any other key is unchanged. */
export const localWorkKey = (key: string, ownHost: string | undefined) => {
  const match = /^([a-z][a-z0-9-]{0,31})~(.+)$/s.exec(key)
  return match && ownHost && match[1] === ownHost ? match[2]! : key
}

/** What a reader says about a cited revision against the one served now. Older revisions are not kept by the host,
 * so an older citation never silently becomes the current copy: the reader shows this and waits for the human. */
export const citedRevision = (cited: number | undefined, current: number | undefined) => {
  if (!cited || !current || cited === current) return undefined
  return cited < current
    ? { kind: "older" as const, text: `You were sent rev ${cited}. This Surface is now at rev ${current}; rev ${cited} is no longer available.` }
    : { kind: "unpublished" as const, text: `You were sent rev ${cited}, which this host has not published (it is at rev ${current}).` }
}

/** Why another host's Surface cannot be shown, from what this app knows of that host. */
export const remoteGap = (input: { host: string; label?: string; known: boolean; current: boolean; withdrawn?: { revision: number; owner: string } }) => {
  const name = input.label ?? input.host
  if (!input.known) return `${input.host} is not a Work host this app reads, so this Surface cannot be opened here.`
  if (!input.current) return `${name} is not answering right now; this Surface cannot be checked or shown until it does.`
  return missingSurface(input.withdrawn, name)
}

/** A Surface a host does not list: withdrawn (its tombstone says by whom and at which revision) or not found. */
export const missingSurface = (withdrawn: { revision: number; owner: string } | undefined, where = "this host") =>
  withdrawn ? `${withdrawn.owner} withdrew this Surface at rev ${withdrawn.revision}; ${where} no longer serves it.`
    : `This Surface is not on ${where}: it was never published there, or was withdrawn before ${where} kept a record of it.`
