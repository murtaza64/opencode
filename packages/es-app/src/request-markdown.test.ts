import { expect, test } from "bun:test"
import { requestMarkdown } from "./request-markdown"

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
