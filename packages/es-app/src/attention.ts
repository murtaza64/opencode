import { createEffect, createSignal, onCleanup, onMount } from "solid-js"

export type AttentionRecord = {
  id: string
  editspace: string
  revision: number
  status: "open" | "snoozed" | "decided" | "resolved" | "withdrawn"
  kind: "decision" | "blocker"
  title: string
  context: string
  options: { id: string; label: string }[]
  recommendation?: string | null
  producer_session: string
  origin_session: string
  gate_key: string
  source_ref: { session_id: string; directory: string }
  decision: { choice_id: string; label?: string } | string | null
  delivery_state: "not-requested"
  created_at: number
  updated_at: number
  snoozed_until?: number | null
}
export type AttentionList = {
  records: AttentionRecord[]
  projects: { editspace: string; available: boolean; error?: string }[]
  partial: boolean
  truncated?: boolean
}
export type AttentionAction = {
  action: "choose" | "snooze" | "wake" | "resolve"
  choice_id?: string
  snoozed_until?: number
  reason?: string
}

export const attentionPath = (path = "", editspace?: string) => `/es/api/attention${path}${editspace ? `?es=${encodeURIComponent(editspace)}` : ""}`

export const decisionLabel = (record: AttentionRecord) => {
  const choice = typeof record.decision === "string" ? record.decision : record.decision?.choice_id
  return record.options.find(option => option.id === choice)?.label ?? (typeof record.decision === "object" ? record.decision?.label : record.decision) ?? "Choice recorded"
}

// Own only the attention read/write interface; neither list nor act admits Session input.
export const createAttention = (project: () => string | undefined) => {
  const [cache, setCache] = createSignal<Record<string, { records: AttentionRecord[]; project: AttentionList["projects"][number]; checked: number }>>({})
  const [scopes, setScopes] = createSignal<Record<string, { checked: number; partial: boolean; truncated: boolean }>>({})
  const snapshot = () => {
    const scope = project()
    const entries = scope ? cache()[scope] ? [cache()[scope]!] : [] : Object.values(cache())
    if (!entries.length && !scopes()[scope ?? ""]) return
    return {
      scope,
      checked: scopes()[scope ?? ""]?.checked ?? Math.min(...entries.map(item => item.checked)),
      value: {
        records: entries.flatMap(item => item.records).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)),
        projects: entries.map(item => item.project),
        partial: entries.some(item => !item.project.available) || (scopes()[scope ?? ""]?.partial ?? !scope),
        truncated: scopes()[scope ?? ""]?.truncated ?? false,
      },
    }
  }
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [operator, setOperator] = createSignal(false)
  const [pending, setPending] = createSignal<{ record: AttentionRecord; body: AttentionAction & { command_id: string; expected_revision: number } }>()
  const [writing, setWriting] = createSignal(false)
  const [notice, setNotice] = createSignal("")
  const [now, setNow] = createSignal(Date.now())
  let version = 0
  let controller: AbortController | undefined
  const refresh = async () => {
    const scope = project()
    const current = ++version
    controller?.abort()
    controller = new AbortController()
    setLoading(true)
    try {
      const pages: AttentionList[] = []
      for (let offset = 0; offset < 10_000; offset += 200) {
        const response = await fetch(`${attentionPath("", scope)}${scope ? "&" : "?"}view=all&limit=200&offset=${offset}`, { signal: controller.signal, credentials: "include" })
        if (!response.ok) throw new Error(response.status === 404 || response.status === 501 ? "Attention ledger is not installed. No decisions have been cleared." : `Attention ledger unavailable (HTTP ${response.status}).`)
        const page: AttentionList = await response.json()
        pages.push(page)
        if (!page.projects.some(item => page.records.filter(record => record.editspace === item.editspace).length === 200)) break
      }
      if (current !== version) return
      const projects = [...new Map(pages.flatMap(page => page.projects).map(item => [item.editspace, item])).values()]
      const unavailable = new Set(pages.flatMap(page => page.projects.filter(item => !item.available).map(item => item.editspace)))
      const checked = Date.now()
      setCache(previous => {
        const next = { ...previous }
        for (const item of projects) next[item.editspace] = {
          records: unavailable.has(item.editspace) ? previous[item.editspace]?.records ?? [] : [...new Map(pages.flatMap(page => page.records).filter(record => record.editspace === item.editspace).map(record => [record.id, record])).values()],
          project: { ...item, available: !unavailable.has(item.editspace) },
          checked: unavailable.has(item.editspace) ? previous[item.editspace]?.checked ?? 0 : checked,
        }
        if (!scope) for (const name of Object.keys(previous)) {
          if (!projects.some(item => item.editspace === name)) next[name] = { ...previous[name]!, project: { editspace: name, available: false, error: "Project no longer observed in registry" } }
        }
        return next
      })
      setScopes(previous => ({ ...previous, [scope ?? ""]: { checked, partial: unavailable.size > 0, truncated: pages.length === 50 } }))
      setError("")
    } catch (cause) {
      if (current !== version) return
      setError(cause instanceof Error ? cause.message : "Attention ledger unavailable.")
    } finally {
      if (current === version) setLoading(false)
    }
  }
  const checkOperator = async () => {
    const response = await fetch(attentionPath("/session"), { credentials: "include" })
    if (response.ok && (await response.json()).operator === true) { setOperator(true); return }
    const bootstrap = await fetch(attentionPath("/session"), { method: "POST", credentials: "include", headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: "{}" })
    setOperator(bootstrap.ok && (await bootstrap.json()).operator === true)
  }
  onMount(() => {
    // Only explicitly allowlisted local UI origins can acquire the operator cookie.
    void checkOperator().catch(() => { setOperator(false) })
    const timer = setInterval(() => { setNow(Date.now()); void refresh() }, 30_000)
    onCleanup(() => { clearInterval(timer); version++; controller?.abort() })
  })
  createEffect(() => { project(); void refresh() })
  const retry = async () => {
    const command = pending()
    if (!command || writing()) return false
    setWriting(true)
    try {
      const send = () => fetch(attentionPath(`/${encodeURIComponent(command.record.id)}/commands`, command.record.editspace), {
        method: "POST", credentials: "include", headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: JSON.stringify(command.body),
      })
      const first = await send()
      const response = first.status === 401
        ? await checkOperator().then(() => operator() ? send() : first)
        : first
      if (!response.ok) {
        if (response.status === 401) {
          setOperator(false)
          setNotice("Operator connection unavailable. Reconnect and retry the same action identity; no local change was assumed.")
          return false
        }
        if (response.status >= 500) {
          setNotice(`Server response failed (HTTP ${response.status}). Outcome unknown; retry the same action identity.`)
          return false
        }
        if (response.status === 403) setOperator(false)
        setNotice(response.status === 409 ? "This record changed. Review the current revision before choosing again." : `Action refused (HTTP ${response.status}); no local change was assumed.`)
        setPending(undefined)
        await refresh()
        return false
      }
      setPending(undefined)
      setNotice(command.body.action === "choose" ? "Decision saved · not sent. No agent was resumed and no tool was approved." : "Saved to the attention ledger.")
      await refresh()
      return true
    } catch {
      setNotice("Response lost. Outcome unknown; retry the same action identity or refresh before proceeding.")
      return false
    } finally { setWriting(false) }
  }
  const act = (record: AttentionRecord, action: AttentionAction) => {
    if (pending() || writing()) return Promise.resolve(false)
    setPending({ record, body: { ...action, expected_revision: record.revision, command_id: crypto.randomUUID() } })
    return retry()
  }
  return {
    snapshot,
    error, loading, operator, pending, writing, notice, now, refresh, checkOperator, act, retry,
    stale: () => !snapshot() || !!error() || now() - snapshot()!.checked > 45_000,
  }
}
