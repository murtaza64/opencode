import { afterEach, expect, test } from "bun:test"
import { readBriefFeedback, sendBriefFeedback } from "./brief-feedback"

const original = globalThis.fetch
afterEach(() => { globalThis.fetch = original })
const calls: { url: string; init?: RequestInit }[] = []
const serve = (status: number, body: unknown) => {
  calls.length = 0
  globalThis.fetch = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return Response.json(body, { status }) }) as typeof fetch
}

test("rating names only the brief shown; source and revision are left to the host", async () => {
  serve(200, { entry: { job: "ses_fdjob_1", rating: "bad" } })
  await sendBriefFeedback({ id: "ses_fdjob_1", directory: "/root" }, "bad", "missed the cost")
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ job: "ses_fdjob_1", directory: "/root", rating: "bad", text: "missed the cost" })
  expect((calls[0]!.init!.headers as Record<string, string>)["X-Attention-CSRF"]).toBe("1")
})

test("an unrated brief reads as undefined, not Neutral", async () => {
  serve(200, { entry: null })
  expect(await readBriefFeedback("ses_fdjob_2")).toBeUndefined()
})

test("a refused rating says why", async () => {
  serve(403, { error: "only the operator UI can rate a brief" })
  await expect(sendBriefFeedback({ id: "ses_fdjob_1", directory: "/root" }, "good")).rejects.toThrow("only the operator UI can rate a brief")
})
