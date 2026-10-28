/* Good / Neutral / Bad (plus an optional note) on one prepared brief, kept apart from the decision. The host's
 * dashboard reads the brief's source, revision and contract from Core itself; the client names only the brief
 * job it showed. No entry means unrated (never Neutral). Rating writes nothing to the attention record. */
export type BriefRating = "good" | "neutral" | "bad"
export type BriefFeedback = {
  job: string; directory: string; source: string; revision: string; contract: number; model: string
  rating: BriefRating | null; text: string; at: number; host: string
  history: { rating: BriefRating | null; text: string; at: number }[]
}

const URL = "/es/api/frontdesk/brief-feedback"

/** The saved feedback for the brief the human is looking at; undefined when it was never rated. */
export const readBriefFeedback = async (job: string) => {
  const response = await fetch(`${URL}?job=${encodeURIComponent(job)}`, { credentials: "include" })
  if (!response.ok) throw new Error(`Feedback unavailable (HTTP ${response.status}).`)
  return ((await response.json()) as { entry: BriefFeedback | null }).entry ?? undefined
}

/** Rates exactly the brief shown (its job and directory), or clears the rating with null. Repeating is harmless. */
export const sendBriefFeedback = async (brief: { id: string; directory: string }, rating: BriefRating | null, text = "") => {
  const response = await fetch(URL, {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json", "X-Attention-CSRF": "1" },
    body: JSON.stringify({ job: brief.id, directory: brief.directory, rating, text }),
  })
  const body = await response.json().catch(() => ({})) as { entry?: BriefFeedback; error?: string }
  if (!response.ok || !body.entry) throw new Error(`Feedback not saved: ${body.error ?? `HTTP ${response.status}`}.`)
  return body.entry
}
