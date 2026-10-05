/* Latest-turn context usage, TUI formula: every token class of the last
 * completed assistant message against the model's context limit. Shared by
 * the composer footer, the right info panel and the sidebar hover card so
 * all three report the same number (and agree with the dashboard's
 * /api/session-insights definition, dotfiles#139). */

export type TokenCounts = {
  input: number
  output: number
  reasoning: number
  cache?: { read?: number; write?: number }
}

export type LatestTurn = {
  providerID: string
  modelID: string
  tokens: TokenCounts
}

export type ProviderList = { providers?: { id: string; models?: Record<string, { limit?: { context?: number } }> }[] }

export const contextTokens = (t: TokenCounts | undefined) =>
  t ? t.input + t.output + t.reasoning + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) : 0

/** A completed assistant turn: the provider finished it and it did not error. */
export const isCompletedTurn = (message: any) =>
  message?.role === "assistant" && !message.error && message.time?.completed != null

export const countCompletedTurns = (messages: any[]) => messages.filter(isCompletedTurn).length

/** Latest completed turn that reported usage; zero-token completions carry no context information. */
export const latestCompletedTurn = (messages: any[]): LatestTurn | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!isCompletedTurn(m) || contextTokens(m.tokens) === 0) continue
    return { providerID: m.providerID, modelID: m.modelID, tokens: m.tokens }
  }
  return null
}

export const contextLimit = (providers: ProviderList | undefined, providerID: string, modelID: string) =>
  providers?.providers?.find((p) => p.id === providerID)?.models?.[modelID]?.limit?.context

/** percent is null (unknown) when the model's limit is not known — never 0 */
export const contextUsage = (turn: LatestTurn | null, providers: ProviderList | undefined) => {
  if (!turn) return null
  const tokens = contextTokens(turn.tokens)
  const limit = contextLimit(providers, turn.providerID, turn.modelID)
  return { tokens, limit: limit ?? null, percent: limit ? Math.round((tokens / limit) * 100) : null }
}

export const usageLevel = (percent: number | null | undefined): "" | "warn" | "high" =>
  percent == null ? "" : percent >= 90 ? "high" : percent >= 70 ? "warn" : ""

export const compactTokens = (n: number) => {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
