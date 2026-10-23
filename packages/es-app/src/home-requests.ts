import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { oc } from "./api"
import type { useDashboard } from "./state"

export type HomeRequest = { kind: "permission" | "question"; id: string; session: string; directory: string; title: string; project?: string }
/** `lastPending`: an unreadable row whose last successful check found it pending. It stays counted
 * so a failing source never makes the queue look healthier than it was. */
export type HomeRequestRow = HomeRequest & { state: "pending" | "unknown" | "unavailable"; checked: number; permission?: PermissionRequest; lastPending?: boolean }
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
        return pointers.filter(item => item.directory === directory && item.kind === kind).map(item => {
          const old = rows().find(row => requestKey(row) === requestKey(item))
          return { ...item, state: "unavailable" as const, checked: old?.checked ?? 0,
            ...(old?.permission ? { permission: old.permission } : {}), lastPending: old?.state === "pending" || !!old?.lastPending }
        })
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

/** Verified state of a request the desk shows. Leaving the queue alone never means answered or granted:
 * only a checked source (the request list or a settled event) says it is no longer waiting. */
export const requestLive = (queued: boolean, item: HomeRequest, rows: HomeRequestRow[], activity: "pending" | "cleared" | "unknown") => {
  if (activity === "cleared") return "cleared" as const
  if (queued) return "pending" as const
  const row = rows.find(candidate => requestKey(candidate) === requestKey(item))
  if (row?.state === "unavailable") return "unavailable" as const
  if (row?.state === "unknown") return "cleared" as const
  return "unknown" as const
}

export type EditFile = { path: string; full?: string; type?: string; movePath?: string; patch: string; additions: number; deletions: number }

/** Files an edit permission would change, from the edit/write (`filepath` + `diff`) or apply_patch (`files`) metadata. */
export const editFiles = (request?: PermissionRequest): EditFile[] => {
  if (request?.permission !== "edit") return []
  const metadata = request.metadata ?? {}
  if (Array.isArray(metadata.files) && metadata.files.length) return metadata.files.flatMap((file: unknown) => {
    if (!file || typeof file !== "object") return []
    const value = file as Record<string, unknown>
    const patch = typeof value.patch === "string" ? value.patch : ""
    const path = typeof value.relativePath === "string" ? value.relativePath : typeof value.filePath === "string" ? value.filePath : ""
    if (!path) return []
    const counted = changes(patch)
    return [{
      path, patch,
      full: typeof value.filePath === "string" ? value.filePath : undefined,
      type: typeof value.type === "string" ? value.type : undefined,
      movePath: typeof value.movePath === "string" ? value.movePath : undefined,
      additions: typeof value.additions === "number" ? value.additions : counted.additions,
      deletions: typeof value.deletions === "number" ? value.deletions : counted.deletions,
    }]
  })
  if (typeof metadata.diff !== "string") return []
  const full = typeof metadata.filepath === "string" ? metadata.filepath : undefined
  const path = request.patterns.find(Boolean) ?? full
  if (!path) return []
  return [{ path, full, patch: metadata.diff, ...changes(metadata.diff) }]
}

const changes = (patch: string) => patch.split("\n").reduce((total, line) => ({
  additions: total.additions + (line.startsWith("+") && !line.startsWith("+++") ? 1 : 0),
  deletions: total.deletions + (line.startsWith("-") && !line.startsWith("---") ? 1 : 0),
}), { additions: 0, deletions: 0 })
