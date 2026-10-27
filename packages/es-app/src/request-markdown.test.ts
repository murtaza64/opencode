import { expect, test } from "bun:test"
import { requestHasSteps, requestMarkdown } from "./request-markdown"

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
