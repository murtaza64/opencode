/* "Look at" places of a Surface revision (DD #753): the change header asks, the reader's frame bridge (owned by
 * SurfaceComments) locates and reveals. A place is located only while the reader shows it; a reveal happens only on an
 * explicit click, never on poll, publish or focus. */
import { createSignal } from "solid-js"

export type LookPlace = { label: string; id?: string; selector?: string }
export type LookState = "shown" | "changed" | "hidden" | "missing" | "unavailable" | "unlocated"

const [places, setPlaces] = createSignal<{ surface: string; places: LookPlace[] }>()
const [request, setRequest] = createSignal<{ surface: string; index: number; nonce: number }>()
const [states, setStates] = createSignal<{ surface: string; states: LookState[] }>()

export const lookKey = (index: number) => `look:${index}`

/** The bridge anchor of a place, or undefined when it names no element (a label the publisher could not resolve). */
export const lookAnchor = (place: LookPlace) =>
  place.id ? { id: place.id } : place.selector ? { selector: place.selector } : undefined

/** The header declares the places of the revision on screen; the bridge tracks them alongside comment anchors. */
export const declareLooks = (surface: string, list: LookPlace[]) => setPlaces({ surface, places: list })
export const looksFor = (surface: string) => places()?.surface === surface ? places()!.places : []

let nonce = 0
export const requestLook = (surface: string, index: number) => setRequest({ surface, index, nonce: ++nonce })
export const lookRequest = request

export const reportLooks = (surface: string, list: LookState[]) => setStates({ surface, states: list })
export const lookStates = (surface: string) => states()?.surface === surface ? states()!.states : undefined

/** What a place's button says beside its label. */
export const lookNote = (state: LookState | undefined, revision: number) =>
  state === "missing" || state === "unlocated" ? `section not found in r${revision}`
    : state === "hidden" ? "hidden in the current view"
      : state === "unavailable" ? "this Surface cannot be navigated from here"
        : undefined
