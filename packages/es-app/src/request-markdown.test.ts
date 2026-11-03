import { expect, test } from "bun:test"
import { requestHasSteps, requestMarkdown, surfaceRouteHref } from "./request-markdown"

test("raw HTML outside code stays literal text", () => {
  expect(requestMarkdown("Click <a href=\"javascript:x()\">here</a> <img src=x onerror=y>")).toBe("Click \\<a href=\"javascript:x()\">here\\</a> \\<img src=x onerror=y>")
})

test("code spans, fenced and indented blocks keep their exact characters", () => {
  const text = ["Run `grep '<x>' f` now:", "```sh", "echo '<b>' | jq '.a < 2'", "```", "    cat <file>", "after <tag>"].join("\n")
  expect(requestMarkdown(text)).toBe(["Run `grep '<x>' f` now:", "```sh", "echo '<b>' | jq '.a < 2'", "```", "    cat <file>", "after \\<tag>"].join("\n"))
})

test("plain prose and Markdown without HTML are unchanged", () => {
  const text = "READY FOR REVIEW\n\n- AI evaluation: https://github.com/o/r/pull/1\n- Math: **two** PRs\n\n1. first\n2. second"
  expect(requestMarkdown(text)).toBe(text)
})

test("a request with numbered steps, or any blocker, counts as steps the human performs", () => {
  const steps = "Add two rules:\n1. Open https://console.example.com/rules\n2) Set Path starts with /api and limit 100 requests per 10 seconds"
  expect(requestHasSteps({ kind: "decision", context: steps })).toBe(true)
  expect(requestHasSteps({ kind: "blocker", context: "Unblock the build" })).toBe(true)
  expect(requestHasSteps({ kind: "decision", context: "Pick 1. Only one numbered line here." })).toBe(false)
  expect(requestHasSteps({ kind: "decision", context: "Version 2.1 shipped in 2026.\nAll good." })).toBe(false)
})

test("a bare Surface route in a request becomes a link to the in-app reader, with its text unchanged", () => {
  expect(requestMarkdown("Surface dotfiles-firefox-workflow rev 5 (/?surface=dotfiles-firefox-workflow). Next", {}))
    .toBe("Surface dotfiles-firefox-workflow rev 5 ([/?surface=dotfiles-firefox-workflow](/?surface=dotfiles-firefox-workflow)). Next")
})

test("item routes link in both the escaped and the plain ':' form", () => {
  expect(requestMarkdown("Try /?item=mini~surface%3Aboard or /?item=mini~surface:board.", {}))
    .toBe("Try [/?item=mini~surface%3Aboard](/?item=mini~surface%3Aboard) or [/?item=mini~surface:board](/?item=mini~surface%3Aboard).")
})

test("on another host's card a route without a host opens that host's Surface; a named host is kept", () => {
  expect(requestMarkdown("See /?surface=report and /?item=wing~surface:map", { host: "mini" }))
    .toBe("See [/?surface=report](/?item=mini~surface%3Areport) and [/?item=wing~surface:map](/?item=wing~surface%3Amap)")
})

test("routes in URLs, code, Markdown links or longer queries stay as written", () => {
  const text = [
    "https://host.test/?surface=a",
    "`/?surface=b`",
    "[board](/?surface=c)",
    "/?surface=d&x=1",
    "/?view=agents",
  ].join("\n")
  expect(requestMarkdown(text, {})).toBe(text)
})

test("without route linking the request text is unchanged", () => {
  expect(requestMarkdown("(/?surface=a)")).toBe("(/?surface=a)")
})

test("surfaceRouteHref accepts only a whole Surface route", () => {
  expect(surfaceRouteHref("/?surface=a.b-c")).toBe("/?surface=a.b-c")
  expect(surfaceRouteHref("/?item=surface:a")).toBe("/?item=surface%3Aa")
  expect(surfaceRouteHref("/?item=surface:a", "mini")).toBe("/?item=mini~surface%3Aa")
  expect(surfaceRouteHref("/session/ses_a")).toBeUndefined()
  expect(surfaceRouteHref("//evil.test/?surface=a")).toBeUndefined()
})
