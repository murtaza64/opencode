export type BriefAction = {
  verb: "post" | "deploy" | "rollback" | "open-prs" | "merge" | "plug" | "restart" | "install" | "grant" | "spend" | "delete"
  to?: { slack: string }
  as?: string
  text?: string
  from?: string
  phone?: string
  version?: string
  build?: string
  soak?: string
  watch?: string
  repo?: string
  prs?: string[]
  view?: string
  keeps?: string[]
  lose?: string
  cmd?: string
}

export type BriefV1 = {
  thing?: string
  happened?: string
  key?: string
  action?: BriefAction
  metric?: { series: number[]; limit?: number; baseline?: number[]; unit?: string; label?: string }
  /** Who acts is the lane; the brief names the one action and what it touches and never touches. */
  scope?: { action: string; touches: string[]; never?: string[] }
  /** A few states side by side; options name the nodes they act on by `id` (or label) in `shows`. */
  flow?: { nodes: { id: string; label: string; state: "ok" | "bad" | "unknown"; note?: string }[] }
  /** Where a secret goes; the value itself is typed into the sealed field, never into the brief. */
  secure?: { dest: string; note?: string }
  /** Per option: what choosing it leads to, and which figure parts it is (`series`, `baseline`, `action`…). */
  options?: Record<string, { consequence?: string; shows?: string[] }>
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const short = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) || undefined : undefined
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const numbers = (value: unknown) => Array.isArray(value) && value.length >= 2 && value.length <= 100 && value.every(finite) ? value as number[] : undefined
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map(item => short(item, 120)).filter((item): item is string => !!item).slice(0, 8) : undefined

export const parseBriefV1 = (value: unknown): BriefV1 | undefined => {
  if (!object(value)) return
  const brief: BriefV1 = {
    ...(short(value.thing, 80) ? { thing: short(value.thing, 80) } : {}),
    ...(short(value.happened, 120) ? { happened: short(value.happened, 120) } : {}),
    ...(short(value.key, 120) ? { key: short(value.key, 120) } : {}),
  }
  if (object(value.action)) {
    const action = value.action
    const verbs: BriefAction["verb"][] = ["post", "deploy", "rollback", "open-prs", "merge", "plug", "restart", "install", "grant", "spend", "delete"]
    if (verbs.includes(action.verb as BriefAction["verb"])) brief.action = {
      verb: action.verb as BriefAction["verb"],
      ...(object(action.to) && short(action.to.slack, 120) ? { to: { slack: short(action.to.slack, 120)! } } : {}),
      ...Object.fromEntries(["as", "text", "from", "phone", "version", "build", "soak", "watch", "repo", "view", "lose", "cmd"].flatMap(field => {
        const text = short(action[field], field === "text" ? 500 : 120)
        return text ? [[field, text]] : []
      })),
      ...(strings(action.prs) ? { prs: strings(action.prs) } : {}),
      ...(strings(action.keeps) ? { keeps: strings(action.keeps) } : {}),
    }
  }
  if (object(value.metric)) {
    const series = numbers(value.metric.series)
    if (series) brief.metric = {
      series,
      ...(finite(value.metric.limit) ? { limit: value.metric.limit } : {}),
      ...(numbers(value.metric.baseline)?.length === series.length ? { baseline: numbers(value.metric.baseline) } : {}),
      ...(short(value.metric.unit, 24) ? { unit: short(value.metric.unit, 24) } : {}),
      ...(short(value.metric.label, 120) ? { label: short(value.metric.label, 120) } : {}),
    }
  }
  if (object(value.scope)) {
    const action = short(value.scope.action, 80)
    // Three of each at most: a scope that lists more is a report, not a picture.
    const touches = strings(value.scope.touches)?.slice(0, 3)
    const never = strings(value.scope.never)?.slice(0, 3)
    if (action && touches?.length) brief.scope = { action, touches, ...(never?.length ? { never } : {}) }
  }
  if (object(value.flow) && Array.isArray(value.flow.nodes)) {
    const nodes = value.flow.nodes.filter(object).flatMap(node => {
      const label = short(node.label, 40)
      if (!label) return []
      const state = (["ok", "bad", "unknown"] as const).find(item => item === node.state) ?? "unknown"
      return [{ id: short(node.id, 40) ?? label, label, state, ...(short(node.note, 60) ? { note: short(node.note, 60) } : {}) }]
    }).slice(0, 5)
    if (nodes.length >= 2) brief.flow = { nodes }
  }
  if (object(value.secure) && short(value.secure.dest, 80)) brief.secure = { dest: short(value.secure.dest, 80)!, ...(short(value.secure.note, 120) ? { note: short(value.secure.note, 120) } : {}) }
  if (object(value.options)) {
    const options = Object.fromEntries(Object.entries(value.options).flatMap(([id, item]) => {
      if (id.length === 0 || id.length > 120 || !object(item)) return []
      const consequence = short(item.consequence, 240)
      const shows = strings(typeof item.shows === "string" ? [item.shows] : item.shows)
      if (!consequence && !shows?.length) return []
      return [[id, { ...(consequence ? { consequence } : {}), ...(shows?.length ? { shows } : {}) }]]
    }))
    if (Object.keys(options).length) brief.options = options
  }
  return Object.keys(brief).length ? brief : undefined
}

/** Which figure parts each option is. Explicit `options.<id>.shows` wins; otherwise the option that takes a secret
 * is the sealed field, and the recommended option is the drawn action or scope; a grant's `once`/`always` options
 * are both the action (the scene marks which key). Flow nodes have no default owner. A metric line belongs to an option only when
 * the brief says so, so an unmapped chart never implies which choice leads where. */
export const optionParts = (brief: BriefV1, options: { id: string; input?: { kind: string } }[], recommendation?: string | null) => Object.fromEntries(options.map(option => {
  const shows = brief.options?.[option.id]?.shows
  if (shows) return [option.id, shows]
  if (brief.secure && option.input?.kind === "secret") return [option.id, ["secure"]]
  if (brief.scope && !brief.action && !brief.metric && option.id === recommendation) return [option.id, ["scope"]]
  if (brief.action?.verb === "grant" && ["once", "always"].includes(option.id)) return [option.id, ["action"]]
  if (brief.action && !brief.metric && option.id === recommendation) return [option.id, ["action"]]
  return [option.id, []]
})) as Record<string, string[]>
