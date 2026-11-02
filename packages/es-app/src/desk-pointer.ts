/* The profile's one Front Desk (desk-pointer-contract-v1): which Core session is the desk, stored by the profile's
 * home host dashboard (GET/PUT /es/api/frontdesk/pointer). Other Work hosts read it through /hosts/<home>/ and chat
 * with that session there; only the home writes the pointer or creates the desk. With no home anywhere the desk keeps
 * this device's own pointer, as before. */
import type { WorkHost } from "./host"
import type { SessionHost } from "./session-host"

export type PointerView = { home: boolean; revision: number; none?: true; session?: string; directory?: string; reason?: string;
  predecessors?: { session: string; directory: string; until: number }[] }

/** Where the desk lives: this host (`local`), another Work host (`remote`), or nowhere configured (`off`). `unreachable`
 * is a remote home this device used before that cannot be read now. */
export type DeskHome =
  | { kind: "off" }
  | { kind: "local"; view: PointerView }
  | { kind: "remote"; host: SessionHost & { id: string; label: string }; view: PointerView }
  | { kind: "unreachable"; host: SessionHost & { id: string; label: string } }

const LAST_HOME = "es-app:front-desk:home:1"

export const readPointer = async (prefix: string, fetcher: typeof fetch = fetch): Promise<PointerView | undefined> => {
  try {
    const response = await fetcher(`${prefix}/es/api/frontdesk/pointer`, { credentials: "include" })
    if (!response.ok) return undefined
    const value = await response.json() as PointerView
    return typeof value?.revision === "number" && typeof value.home === "boolean" ? value : undefined
  } catch { return undefined }
}

/** The home from what each host reported: this host when it says so, else the first Work host that does. A remote home
 * this device used last that cannot be read now stays the home (read-only), never replaced by a second desk. */
export const homeOf = (local: PointerView | undefined, remotes: { host: WorkHost; view: PointerView | undefined }[], last?: string): DeskHome => {
  if (local?.home) return { kind: "local", view: local }
  const found = remotes.find(entry => entry.view?.home)
  const host = (item: WorkHost) => ({ id: item.id, label: item.label, base: `/hosts/${item.id}/oc` })
  if (found) return { kind: "remote", host: host(found.host), view: found.view! }
  const previous = last ? remotes.find(entry => entry.host.id === last) : undefined
  return previous ? { kind: "unreachable", host: host(previous.host) } : { kind: "off" }
}

export const resolveHome = async (hosts: WorkHost[], fetcher: typeof fetch = fetch): Promise<DeskHome> => {
  const [local, ...views] = await Promise.all([readPointer("", fetcher), ...hosts.map(host => readPointer(`/hosts/${host.id}`, fetcher))])
  let last: string | undefined
  try { last = localStorage.getItem(LAST_HOME) ?? undefined } catch { /* no memory of a home */ }
  const home = homeOf(local, hosts.map((host, index) => ({ host, view: views[index] })), last)
  try {
    if (home.kind === "remote") localStorage.setItem(LAST_HOME, home.host.id)
    if (home.kind === "local") localStorage.removeItem(LAST_HOME)
  } catch { /* remembered for this page only */ }
  return home
}

/** Compare-and-swap the pointer on this (home) host. `ok: false` carries the pointer that won. */
export const writePointer = async (body: { expected_revision: number; session: string; directory: string; reason: "create" | "successor" | "new" | "import" },
  fetcher: typeof fetch = fetch): Promise<{ ok: true; view: PointerView } | { ok: false; view?: PointerView; error?: string }> => {
  try {
    const response = await fetcher("/es/api/frontdesk/pointer", { method: "PUT", credentials: "include",
      headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: JSON.stringify(body) })
    const value = await response.json().catch(() => undefined) as PointerView | { error?: string } | undefined
    if (response.ok) return { ok: true, view: value as PointerView }
    if (response.status === 409) return { ok: false, view: value as PointerView }
    return { ok: false, error: (value as { error?: string } | undefined)?.error ?? `HTTP ${response.status}` }
  } catch (cause) { return { ok: false, error: String(cause) } }
}

/** An earlier Front Desk conversation, still readable: on this host (`host` absent) or on the home host. */
export type EarlierDesk = { session: string; directory: string; host?: SessionHost & { id: string; label: string }; from: "device" | "home"; until?: number }

/** Earlier desks, newest first, without the current one: the home's replaced desks and this device's own earlier
 * desk(s). Nothing is deleted; each stays a normal conversation. */
export const earlierDesks = (home: DeskHome, current: string | undefined, device: { session: string; directory: string }[]): EarlierDesk[] => {
  const host = home.kind === "remote" || home.kind === "unreachable" ? home.host : undefined
  const fromHome = home.kind === "local" || home.kind === "remote"
    ? [...home.view.predecessors ?? []].reverse().map((entry): EarlierDesk => ({ ...entry, ...(host ? { host } : {}), from: "home" }))
    : []
  const all = [...device.map((entry): EarlierDesk => ({ session: entry.session, directory: entry.directory, from: "device" })), ...fromHome]
  return all.filter((entry, index) => entry.session !== current && all.findIndex(other => other.session === entry.session) === index)
}

/** Show "This is now the shared Work Front Desk" once per shared desk, on a device that had its own desk before. */
export const sharedNotice = (home: DeskHome, current: string | undefined, earlier: EarlierDesk[], seen: string | undefined) =>
  (home.kind === "local" || home.kind === "remote") && !!current && seen !== current && earlier.some(entry => entry.from === "device")
