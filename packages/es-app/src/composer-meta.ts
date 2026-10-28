import { compactTokens, usageLevel } from "./context-usage"

// Composer footer meta (ux-feel contract): the session's estimated cost and how full the context
// is, next to Send. Both come from data the session already has; nothing here reads more.

export type FooterContext = { text: string; title: string; level: "" | "warn" | "high" }

/**
 * Context of the latest completed turn against the selected model's window. The percent needs a
 * known limit; without one the token count shows instead, never a guessed window. When the turn
 * ran on another model the title says so, since the number was measured there.
 */
export const footerContext = (input: {
  used: number | undefined
  limit: number | undefined
  selected?: string
  turnModel?: string
}): FooterContext | undefined => {
  if (!input.used) return
  const other = input.selected && input.turnModel && input.selected !== input.turnModel ? ` (measured on ${input.turnModel})` : ""
  if (!input.limit) return { text: `${compactTokens(input.used)} ctx`, level: "",
    title: `Context used by the latest turn: ${compactTokens(input.used)}${other}. ${input.selected ?? "The selected model"} has no known context limit.` }
  const percent = Math.min(100, Math.round((input.used / input.limit) * 100))
  return { text: `${percent}%`, level: usageLevel(percent),
    title: `Context used by the latest turn: ${compactTokens(input.used)} of ${compactTokens(input.limit)}${input.selected ? ` (${input.selected})` : ""}${other}` }
}

export type FooterCost = { known: true; value: number; text: string; decade: 0 | 1 | 2 | 3 } | { known: false; text: string }

/** Session cost estimate. Unknown until the session or a reply records a cost; unknown is never $0. */
export const footerCost = (sessionCost: unknown, replyCosts: readonly unknown[]): FooterCost => {
  const replies = replyCosts.filter((cost): cost is number => typeof cost === "number" && Number.isFinite(cost))
  const known = (typeof sessionCost === "number" && Number.isFinite(sessionCost)) || replies.length > 0
  if (!known) return { known: false, text: "~$?" }
  // Matches the info panel: a recorded session cost wins unless it is zero and replies say otherwise.
  const value = (typeof sessionCost === "number" && sessionCost) || replies.reduce((sum, cost) => sum + cost, 0)
  return { known: true, value, text: `~$${value.toFixed(2)}`, decade: value < 1 ? 0 : value < 10 ? 1 : value < 100 ? 2 : 3 }
}
