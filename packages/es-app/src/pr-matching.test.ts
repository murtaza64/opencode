import { expect, test } from "bun:test"
import { matchPrRef, prFromHref } from "./pr-matching"

const url = "https://github.com/duolingo/infra-core/pull/10265"

test("matches a short repo ref from canonical transcript links without dashboard metadata", () => {
  expect(matchPrRef("infra-core#10265", [url])?.url).toBe(url)
})

test("deduplicates canonical, Ink, case and fragment variants", () => {
  expect(
    matchPrRef("INFRA-CORE#10265", [url, `https://duo.fyi/ink/${url}#discussion_r1`, `${url.toUpperCase()}/files`])
      ?.url,
  ).toBe(url)
})

test("does not guess an owner or match a repo suffix or number alone", () => {
  expect(matchPrRef("infra-core#10265", [])).toBeNull()
  expect(matchPrRef("core#10265", [url])).toBeNull()
  expect(matchPrRef("#10265", [url])).toBeNull()
  expect(matchPrRef("infra-core#10266", [url])).toBeNull()
})

test("ambiguous short repo names do not guess an owner", () => {
  expect(matchPrRef("infra-core#10265", [url, "https://github.com/other/infra-core/pull/10265"])).toBeNull()
  expect(matchPrRef("infra-core#10265", [url, "https://github.com/other/infra-core/pull/1"])).toBeNull()
})

test("fully qualified references resolve only their exact owner", () => {
  expect(matchPrRef("duolingo/infra-core#10265", [url, "https://github.com/other/infra-core/pull/10265"])?.url).toBe(
    url,
  )
  expect(matchPrRef("other/infra-core#10265", [url])).toBeNull()
})

test("explicit issue URLs override a known bare PR candidate", () => {
  expect(matchPrRef("infra-core#10265", [url], "https://github.com/duolingo/infra-core/issues/10265")).toBeNull()
  expect(
    matchPrRef("infra-core#10265", [url], "https://duo.fyi/ink/https://github.com/duolingo/infra-core/issues/10265"),
  ).toBeNull()
})

test("explicit PR URLs override conflicting text and ambiguous candidates", () => {
  expect(matchPrRef("other/repo#1", ["https://github.com/other/infra-core/pull/10265"], url)?.url).toBe(url)
})

test.each([
  "https://github.com.evil.test/duolingo/infra-core/pull/10265",
  "https://github.com/duolingo/infra-core/issues/10265",
  "https://github.com/duolingo/infra-core/pull/10265-extra",
  "https://github.com/duolingo/infra-core/pull/10265extra",
])("rejects noncanonical PR URL %s", (href) => {
  expect(prFromHref(href)).toBeNull()
  expect(matchPrRef("infra-core#10265", [href])).toBeNull()
})

test("candidate replacement does not retain a previous session's links", () => {
  expect(matchPrRef("infra-core#10265", [url])?.url).toBe(url)
  expect(matchPrRef("infra-core#10265", [])).toBeNull()
})
