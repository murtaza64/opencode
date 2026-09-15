import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { es } from "./api"

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
beforeEach(() => { fetchSpy = spyOn(globalThis, "fetch") })
afterEach(() => fetchSpy.mockRestore())

test("bare GitHub refs fetch the selected tracker's numeric issue", async () => {
  fetchSpy.mockResolvedValue(Response.json({ ref: "77", title: "Selected issue" }))
  expect(await es.issue("#77", "my project")).toMatchObject({ ref: "77", title: "Selected issue" })
  expect(fetchSpy.mock.calls).toEqual([["/es/api/issue?ref=77&es=my%20project"]])
})

test.each(["dotfiles#77", "murtaza64/dotfiles#77", "Dotfiles#77"])(
  "%s resolves only after matching the selected GitHub tracker",
  async (ref) => {
    fetchSpy.mockResolvedValueOnce(Response.json({ backend: "gh", repo: "murtaza64/dotfiles", issues: [] }))
    fetchSpy.mockResolvedValueOnce(Response.json({ ref: "77", title: "Selected issue" }))
    expect(await es.issue(ref, "test")).toMatchObject({ ref: "77", title: "Selected issue" })
    expect(fetchSpy.mock.calls).toEqual([
      ["/es/api/issues?es=test"],
      ["/es/api/issue?ref=77&es=test"],
    ])
  },
)

test.each([
  ["opencode#77", { backend: "gh", repo: "murtaza64/dotfiles", issues: [] }],
  ["other/dotfiles#77", { backend: "gh", repo: "murtaza64/dotfiles", issues: [] }],
  ["dotfiles#77", { backend: "jira", repo: "murtaza64/dotfiles", issues: [] }],
  ["dotfiles#77", { backend: "markdown", issues: [] }],
  ["dotfiles#77", { backend: "gh", issues: [] }],
] as const)("rejects %s when tracker metadata cannot establish a match", async (ref, tracker) => {
  fetchSpy.mockResolvedValue(Response.json(tracker))
  await expect(es.issue(ref, "test")).rejects.toThrow("does not match")
  expect(fetchSpy.mock.calls).toEqual([["/es/api/issues?es=test"]])
})

test("tracker discovery failure never falls through to a numeric issue lookup", async () => {
  fetchSpy.mockResolvedValue(Response.json({ error: "tracker unavailable" }, { status: 503 }))
  await expect(es.issue("dotfiles#77")).rejects.toThrow("HTTP 503")
  expect(fetchSpy.mock.calls).toEqual([["/es/api/issues?"]])
})

test("tracker error payload never falls through to a numeric issue lookup", async () => {
  fetchSpy.mockResolvedValue(Response.json({ backend: "gh", repo: "murtaza64/dotfiles", error: "tracker unavailable" }))
  await expect(es.issue("dotfiles#77")).rejects.toThrow("tracker unavailable")
  expect(fetchSpy.mock.calls).toEqual([["/es/api/issues?"]])
})

test.each([
  ["SD-123", "/es/api/issue?ref=SD-123&"],
  ["77", "/es/api/issue?ref=77&"],
  ["issues/fix/01-ticket.md", "/es/api/issue?ref=issues%2Ffix%2F01-ticket.md&"],
])("preserves the existing reader for %s", async (ref, url) => {
  fetchSpy.mockResolvedValue(Response.json({ ref }))
  expect((await es.issue(ref)).ref).toBe(ref)
  expect(fetchSpy.mock.calls).toEqual([[url]])
})
