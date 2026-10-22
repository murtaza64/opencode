import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { oc } from "./api"
import type { useDashboard } from "./state"

export type HomeRequest = { kind: "permission" | "question"; id: string; session: string; directory: string; title: string; project?: string }
export type HomeRequestRow = HomeRequest & { state: "pending" | "unknown" | "unavailable"; checked: number; permission?: PermissionRequest }
export const requestKey = (item: HomeRequest) => JSON.stringify([item.directory, item.kind, item.id])

/** Pending-request pointers from live session activity and dashboard notification hints, deduplicated by exact identity. */
export const requestPointers = (dashboard: ReturnType<typeof useDashboard>): HomeRequest[] => {
  const projectFor = (directory: string) => dashboard.editspaces()?.editspaces.find(item => {
    const root = item.root.replace(/\/+$/, "").replace(/\/\.editspace$/, "")
    return directory === root || directory.startsWith(`${root}/`)
  })?.name
  const direct = dashboard.activity.requests().map(item => ({ kind: item.kind, id: item.request.id, session: item.request.sessionID, directory: item.directory, project: projectFor(item.directory), title: dashboard.activity.session(item.request.sessionID)?.title ?? item.request.sessionID }))
  const hints = dashboard.notifications().filter(item => item.kind !== "idle").map(item => ({ ...item, project: item.editspace || projectFor(item.directory), kind: item.kind as "permission" | "question", id: item.id.startsWith(`${item.kind}:`) ? item.id.slice(item.kind.length + 1) : item.id }))
  return [...new Map([...hints, ...direct].map(item => [requestKey(item), item])).values()]
}

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
