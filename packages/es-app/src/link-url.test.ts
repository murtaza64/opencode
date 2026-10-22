import { expect, test } from "bun:test"
import { appPath, linkUrl } from "./link-url"

test.each([
  ["https://github.com/owner/repo/pull/123", "https://duo.fyi/ink/https://github.com/owner/repo/pull/123"],
  ["https://github.com/owner/repo/pull/123/files?diff=split&x=%2F#review-42", "https://duo.fyi/ink/https://github.com/owner/repo/pull/123/files?diff=split&x=%2F#review-42"],
  ["http://github.com/owner/repo/pull/1/commits", "https://duo.fyi/ink/http://github.com/owner/repo/pull/1/commits"],
  ["https://GITHUB.COM/owner/repo/pull/1?#", "https://duo.fyi/ink/https://GITHUB.COM/owner/repo/pull/1?#"],
  ["https://github.com:443/owner/repo/pull/1", "https://duo.fyi/ink/https://github.com:443/owner/repo/pull/1"],
  ["https://duo.fyi/ink/https://github.com/owner/repo/pull/123?x=1#review", "https://duo.fyi/ink/https://github.com/owner/repo/pull/123?x=1#review"],
  ["https://duo.fyi/ink/https://github.com/owner/repo/issues/123?x=%2f#comment", "https://github.com/owner/repo/issues/123?x=%2f#comment"],
  ["https://DUO.FYI:443/ink/https://github.com/owner/repo?tab=readme#top", "https://github.com/owner/repo?tab=readme#top"],
  ["https://duo.fyi/ink/https://github.com/owner/repo/pull/123abc", "https://github.com/owner/repo/pull/123abc"],
  ["https://duo.fyi/ink/https://u:p@github.com/owner/repo/pull/1", "https://u:p@github.com/owner/repo/pull/1"],
])("routes the GitHub destination without losing its suffix: %s", (input, expected) => {
  expect(linkUrl(input)).toBe(expected)
  expect(linkUrl(expected)).toBe(expected)
})

test.each([
  "https://github.com/owner/repo/issues/1",
  "https://github.com/owner/repo",
  "https://github.com/owner/repo/commit/abc123",
  "https://github.com/owner/repo/blob/dev/file.ts",
  "https://github.com/owner/repo/discussions/1",
  "https://github.com/owner/repo/releases/tag/v1",
  "https://github.com/owner",
  "https://github.com/owner/repo/pulls",
  "https://github.com/owner/repo/pull/123abc",
  "https://github.com/owner/repo/pull/123.patch",
  "https://github.com/owner/repo/pull/123%2Ffiles",
  "https://github.com/owner/repo/pull/0",
  "https://github.com/owner/repo/pull/-1",
  "https://github.com/owner/repo/pull/",
  "https://github.com/bad_owner/repo/pull/1",
  "https://github.com/owner//pull/1",
  "https://github.com.example.org/owner/repo/pull/1",
  "https://github.com@evil.example/owner/repo/pull/1",
  "https://github.com./owner/repo/pull/1",
  "https://u:p@github.com/owner/repo/pull/1",
  "https://github.com:444/owner/repo/pull/1",
  "https://duo.fyi.evil.example/ink/https://github.com/owner/repo/issues/1",
  "https://duo.fyi/ink/https://example.org/owner/repo/issues/1",
  "javascript:https://github.com/owner/repo/pull/1",
  "https://github.com/owner/repo/pull/1\n",
  "/session/ses_a?directory=/work",
])("does not route a non-PR or unsupported destination through Ink: %s", (input) => {
  expect(linkUrl(input)).toBe(input)
})

const native = "http://127.0.0.1:60302"
const session = "/session/ses_e9bdef7e4ffeo9XgAIryoyMX2Z?directory=%2FUsers%2Fme%2Fproj"
test.each([
  [`http://127.0.0.1:3181${session}`, session],
  [`http://localhost:3100${session}#bottom`, `${session}#bottom`],
  [`${native}${session}`, session],
  [`http://127.0.0.1:3181${session}&message=msg_a&to=msg_b`, `${session}&message=msg_a&to=msg_b`],
  [session, session],
  ["/desk", "/desk"],
  ["http://127.0.0.1:3181/map?view=weave", "/map?view=weave"],
  ["http://127.0.0.1:3181/", "/"],
])("an es-app link opens in the clicked client: %s", (input, expected) => {
  expect(appPath(input, native)).toBe(expected)
})

test.each([
  "https://github.com/owner/repo/pull/1",
  "http://127.0.0.1:64297/map",
  "http://127.0.0.1:7777/session/ses_a",
  "http://example.com:3181/session/ses_a",
  "https://127.0.0.1:3181/session/ses_a",
  "http://u:p@127.0.0.1:3181/session/ses_a",
  "http://127.0.0.1:3181/oc/session",
  "http://127.0.0.1:3181/es/api/state",
  "http://127.0.0.1:3181/assets/index.js",
  "http://127.0.0.1:3181/session/ses_a/extra",
  "mailto:me@example.com",
])("other destinations stay external: %s", (input) => {
  expect(appPath(input, native)).toBeUndefined()
})
