import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { oc } from "./api"

export type HomeRequest = { kind: "permission" | "question"; id: string; session: string; directory: string; title: string; project?: string }
export type HomeRequestRow = HomeRequest & { state: "pending" | "unknown" | "unavailable"; checked: number; permission?: PermissionRequest }
export const requestKey = (item: HomeRequest) => JSON.stringify([item.directory, item.kind, item.id])

// Validate exact pending pointers; a missing deferred is not an answered/granted request.
export const createHomeRequests = (sources: () => HomeRequest[], settled: (item: HomeRequest) => boolean = () => false) => {
  const [rows, setRows] = createSignal<HomeRequestRow[]>([])
  const [now, setNow] = createSignal(Date.now())
  let generation = 0
  const refresh = async () => {
    const current = ++generation
    const pointers = sources()
    const groups = [...new Set(pointers.map(item => item.directory))]
    const result = await Promise.all(groups.flatMap(directory => (["permission", "question"] as const).map(async kind => {
      try {
        const requests = await (kind === "permission" ? oc.permissions(directory) : oc.questions(directory))
        return pointers.filter(item => item.directory === directory && item.kind === kind).map(item => {
          const request = requests.find(request => request.id === item.id && request.sessionID === item.session)
          // Keep the validated permission's own context for an exact reply from Home.
          return { ...item, state: request ? "pending" as const : "unknown" as const, checked: Date.now(), ...(request && kind === "permission" ? { permission: request as PermissionRequest } : {}) }
        })
      } catch {
        return pointers.filter(item => item.directory === directory && item.kind === kind).map(item => ({ ...item, state: "unavailable" as const, checked: rows().find(old => requestKey(old) === requestKey(item))?.checked ?? 0 }))
      }
    })))
    if (generation !== current) return
    setRows(previous => {
      const next = result.flat()
      // Keep a pointer when a source disappears, without claiming its outcome.
      return [...next, ...previous.filter(old => !next.some(item => requestKey(item) === requestKey(old))).map(old => ({ ...old, state: "unknown" as const }))].filter(item => !settled(item))
    })
  }
  createEffect(() => { sources(); void refresh() })
  onMount(() => {
    const interval = setInterval(() => { setNow(Date.now()); void refresh() }, 30_000)
    onCleanup(() => { clearInterval(interval); generation++ })
  })
  return { rows, now, refresh }
}
