/* The Work host a session view belongs to. Every read, stream, write and stored draft in the view
 * goes to this host's Core: `/oc` for this page's own host, `/hosts/<id>/oc` (through the Local
 * listener) for another Work host. Nothing in the view falls back to another host. */
import { createContext, useContext } from "solid-js"
import { ocAt } from "./api"

/** `id`: another Work host's id; undefined for this page's own host. */
export type SessionHost = { id?: string; label?: string; base: string }

const context = createContext<SessionHost>({ base: "/oc" })

export const SessionHostProvider = context.Provider
export const useSessionHost = () => useContext(context)
/** Core client for the view's host. */
export const useOc = () => ocAt(useContext(context).base)
