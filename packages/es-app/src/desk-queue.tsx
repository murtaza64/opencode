/* The Front desk queue as app-wide state: one attention reader, one pending-request check and one
 * failure-ignore list, shared by the desk and the mode switch badge. Mounted once in the shell so
 * the Agents mode count comes from the same reads the desk shows, not a second poller. */
import { createContext, createMemo, onMount, useContext, type ParentProps } from "solid-js"
import { useDashboard } from "./state"
import { createAttention } from "./attention"
import { createHomeRequests, requestPointers } from "./home-requests"
import { createFailureIgnores } from "./failure-ignores"
import { deskItems } from "./desk"
import { useBriefs } from "./desk-briefs"
import { createSurfaces } from "./surfaces"

const create = () => {
  const dashboard = useDashboard()
  const project = () => dashboard.allProjects() ? undefined : dashboard.editspace() ?? dashboard.editspaces()?.default ?? undefined
  // Operator setup (cookie bootstrap, unsent-answer recovery) waits for the desk itself.
  const attention = createAttention(project, { deferOperator: true })
  const requests = createHomeRequests(createMemo(() => requestPointers(dashboard)), item => dashboard.activity.requestSettled(item.kind, item.directory, item.id))
  // Ignored failures live in the dashboard's file so they stay hidden on every client and reload.
  const ignores = createFailureIgnores()
  onMount(() => void ignores.load())
  const projectFor = (directory: string) => dashboard.editspaces()?.editspaces.find(item => {
    const root = item.root.replace(/\/+$/, "").replace(/\/\.editspace$/, "")
    return directory === root || directory.startsWith(`${root}/`)
  })?.name
  const briefs = useBriefs().briefs
  const briefSessions = createMemo(() => new Set(briefs.jobs().map(job => job.id).filter(Boolean)))
  // The desk's own brief passes are not work waiting on the human.
  const failures = createMemo(() => dashboard.scopedFailures().filter(failure => !briefSessions().has(failure.sessionID)))
  const items = createMemo(() => deskItems({
    records: attention.snapshot()?.value.records ?? [],
    attentionChecked: attention.snapshot()?.checked ?? 0,
    requests: requests.rows().filter(item => !project() || !item.project || item.project === project()),
    failures: failures().filter(failure => !ignores.ignored(failure)),
    failuresChecked: dashboard.failures.checked() ?? 0,
    title: id => dashboard.activity.session(id)?.title,
    project: projectFor,
  }))
  // Surfaces and requested deliverables; new deliverables also feed the mode badge.
  const surfaces = createSurfaces()
  return { project, attention, requests, ignores, failures, items, surfaces }
}

const Context = createContext<ReturnType<typeof create>>()
export const DeskQueueProvider = (props: ParentProps) => <Context.Provider value={create()}>{props.children}</Context.Provider>
export const useDeskQueue = () => {
  const value = useContext(Context)
  if (!value) throw new Error("useDeskQueue outside DeskQueueProvider")
  return value
}
