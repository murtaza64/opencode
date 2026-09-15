import { expect, test } from "bun:test"
import { classifyRef, refFromHref, ticketLookupRef, ticketMatchesRef, ticketUrl } from "./ticket-url"

test("fully qualified GitHub tickets link to GitHub, not Jira", () => {
  expect(ticketUrl("murtaza64/dotfiles#77")).toBe("https://github.com/murtaza64/dotfiles/issues/77")
})

test.each([
  ["SD-123", "https://duolingo.atlassian.net/browse/SD-123"],
  ["DLAA-31571", "https://duolingo.atlassian.net/browse/DLAA-31571"],
  ["dotfiles#77", "/issue?ref=dotfiles%2377"],
  ["#77", "/issue?ref=%2377"],
  ["77", "/issue?ref=77"],
  ["sd-123", "/issue?ref=sd-123"],
  ["issues/fix/01-ticket.md", "/issue?ref=issues%2Ffix%2F01-ticket.md"],
])("resolves %s without inventing tracker context", (key, href) => {
  expect(ticketUrl(key)).toBe(href)
})

test.each(["SD-123", "murtaza64/dotfiles#77", "dotfiles#77", "#77"])(
  "prefers a supplied URL over %s",
  (key) => {
    expect(ticketUrl(key, "https://github.com/other/repo/issues/12")).toBe("https://github.com/other/repo/issues/12")
    expect(ticketUrl(key, "https://duolingo.atlassian.net/browse/SD-456")).toBe("https://duolingo.atlassian.net/browse/SD-456")
    expect(ticketUrl(key, "https://duo.fyi/ink/https://github.com/other/repo/issues/12")).toBe(
      "https://duo.fyi/ink/https://github.com/other/repo/issues/12",
    )
  },
)

test.each(["https://github.com/other/repo/issues/12", "https://duo.fyi/ink/https://github.com/other/repo/issues/12"])(
  "explicit issue URL %s overrides conflicting text",
  (href) => {
    const ref = classifyRef("SD-123", href)
    expect(ref.ref).toBe("other/repo#12")
    expect(ref.kind).toBe("github")
    expect(ref.href).toBe(href)
  },
)

test("repo-qualified refs require matching tracker metadata before a numeric lookup", () => {
  const ref = classifyRef("murtaza64/dotfiles#77")
  expect(ref.ref).toBe("murtaza64/dotfiles#77")
  expect(ticketLookupRef(ref)).toBeUndefined()
  expect(ticketLookupRef(ref, "other/dotfiles")).toBeUndefined()
  expect(ticketLookupRef(ref, "murtaza64/dotfiles")).toBe("77")
  expect(ref.href).toBe("https://github.com/murtaza64/dotfiles/issues/77")
})

test("short repo-qualified refs never become lookups in a different repo", () => {
  const ref = classifyRef("dotfiles#77")
  expect(ref.ref).toBe("dotfiles#77")
  expect(ticketLookupRef(ref)).toBeUndefined()
  expect(ticketLookupRef(ref, "murtaza64/opencode")).toBeUndefined()
  expect(ticketLookupRef(ref, "murtaza64/dotfiles")).toBe("77")
  expect(ref.href).toBe("/issue?ref=dotfiles%2377")
})

test("Jira and bare refs keep their existing tracker lookups", () => {
  expect(ticketLookupRef(classifyRef("SD-123"))).toBe("SD-123")
  expect(ticketLookupRef(classifyRef("#77"))).toBe("77")
})

test("qualified refs reject unrelated issue metadata and accept matching URLs", () => {
  const issue = { ref: "77", number: 77, url: "https://github.com/murtaza64/dotfiles/issues/77" }
  expect(ticketMatchesRef("murtaza64/dotfiles#77", issue)).toBe(true)
  expect(ticketMatchesRef("dotfiles#77", issue)).toBe(true)
  expect(ticketMatchesRef("#77", issue)).toBe(true)
  expect(ticketMatchesRef("opencode#77", issue)).toBe(false)
  expect(ticketMatchesRef("other/dotfiles#77", issue)).toBe(false)
  expect(ticketMatchesRef("dotfiles#78", issue)).toBe(false)
  expect(ticketMatchesRef("dotfiles#77", { ...issue, url: "" })).toBe(false)
  expect(ticketMatchesRef("SD-77", issue)).toBe(false)
})

test("Jira metadata must match the referenced key", () => {
  const issue = { ref: "SD-123", number: null, url: "https://duolingo.atlassian.net/browse/SD-123" }
  expect(ticketMatchesRef("SD-123", issue)).toBe(true)
  expect(ticketMatchesRef("SD-124", issue)).toBe(false)
  expect(ticketMatchesRef("#123", issue)).toBe(false)
})

test("GitHub identity matching is case insensitive and accepts Ink-wrapped URLs", () => {
  const issue = { ref: "77", number: 77, url: "https://duo.fyi/ink/https://github.com/Murtaza64/Dotfiles/issues/77" }
  expect(ticketMatchesRef("murtaza64/dotfiles#77", issue)).toBe(true)
  expect(ticketLookupRef(classifyRef("dotfiles#77"), "Murtaza64/Dotfiles")).toBe("77")
})

test("empty supplied URLs fall back to the reference", () => {
  expect(ticketUrl("murtaza64/dotfiles#77", "")).toBe("https://github.com/murtaza64/dotfiles/issues/77")
  expect(ticketUrl("#77", null)).toBe("/issue?ref=%2377")
})

test.each([
  ["https://github.com/owner/repo/issues/77#issuecomment-12", "owner/repo#77"],
  ["https://duolingo.atlassian.net/browse/SD-123?focusedCommentId=1", "SD-123"],
  ["https://github.com/owner/repo/pull/77", null],
  ["https://github.com.evil.test/owner/repo/issues/77", null],
  ["https://github.com/owner/repo/issues/77extra", null],
])("recognizes ticket identity from %s", (href, ref) => {
  expect(refFromHref(href!)).toBe(ref)
})
