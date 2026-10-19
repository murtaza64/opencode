import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { oc } from "./api"

export type HomeRequest = { kind: "permission" | "question"; id: string; session: string; directory: string; title: string; project?: string }
export const requestKey = (item: HomeRequest) => JSON.stringify([item.directory, item.kind, item.id])

// Validate exact pending pointers; a missing deferred is not an answered/granted request.
export const createHomeRequests = (sources: () => HomeRequest[]) => {
  const [rows, setRows] = createSignal<(HomeRequest & { state: "pending" | "unknown" | "unavailable"; checked: number })[]>([])
  const [now, setNow] = createSignal(Date.now())
  let generation = 0
  const refresh = async () => {
    const current = ++generation
    const pointers = sources()
    const groups = [...new Set(pointers.map(item => item.directory))]
    const result = await Promise.all(groups.map(async directory => {
      try {
        const [permissions, questions] = await Promise.all([oc.permissions(directory), oc.questions(directory)])
        return pointers.filter(item => item.directory === directory).map(item => ({ ...item, state: (item.kind === "permission" ? permissions : questions).some(request => request.id === item.id && request.sessionID === item.session) ? "pending" as const : "unknown" as const, checked: Date.now() }))
      } catch {
        return pointers.filter(item => item.directory === directory).map(item => ({ ...item, state: "unavailable" as const, checked: rows().find(old => requestKey(old) === requestKey(item))?.checked ?? 0 }))
      }
    }))
    if (generation !== current) return
    setRows(previous => {
      const next = result.flat()
      // Keep a pointer when a source disappears, without claiming its outcome.
      return [...next, ...previous.filter(old => !next.some(item => requestKey(item) === requestKey(old))).map(old => ({ ...old, state: "unknown" as const }))]
    })
  }
  createEffect(() => { sources(); void refresh() })
  onMount(() => {
    const interval = setInterval(() => { setNow(Date.now()); void refresh() }, 30_000)
    onCleanup(() => { clearInterval(interval); generation++ })
  })
  return { rows, now, refresh }
}
