// The message is shown to people, so proxy error pages (HTML) collapse to the status and long
// bodies are cut; the raw body stays on `body` for callers and diagnostics.
export class HttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`HTTP ${status}${summary(body)}`)
  }
}

const summary = (body: unknown) => {
  if (body === "" || body === undefined || body === null) return ""
  if (typeof body === "string" && /^\s*</.test(body)) return ""
  const text = (typeof body === "string" ? body : JSON.stringify(body)).replace(/\s+/g, " ").trim()
  return text.length > 160 ? ` ${text.slice(0, 160)}…` : ` ${text}`
}

export const httpError = async (response: Response) => {
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Plain-text and malformed responses remain available as raw text.
  }
  return new HttpError(response.status, body)
}

export const supersededError = (error: unknown, sessionID: string) => {
  if (!(error instanceof HttpError) || error.status !== 409) return
  const body = error.body
  if (typeof body !== "object" || body === null || !("_tag" in body) || body._tag !== "SessionSupersededError" ||
    !("sessionID" in body) || body.sessionID !== sessionID || !("successor" in body) ||
    typeof body.successor !== "string" || !/^ses_[\w-]+$/.test(body.successor) || body.successor === sessionID ||
    !("state" in body) || (body.state !== "pending" && body.state !== "committed")) return
  return { successor: body.successor, state: body.state as "pending" | "committed" }
}
