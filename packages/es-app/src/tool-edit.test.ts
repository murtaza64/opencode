import { expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { editSummary } from "./tool-edit"

const part = (tool: string, state: Record<string, unknown>) =>
  ({ id: "p", messageID: "m", sessionID: "s", type: "tool", tool, callID: "c", state }) as unknown as ToolPart
const done = (input: Record<string, unknown>, metadata: Record<string, unknown>) =>
  ({ status: "completed", input, output: "ok", title: "", metadata, time: { start: 1, end: 2 } })

test("an edit reports its file and line counts from filediff", () => {
  expect(editSummary(part("edit", done({ filePath: "/w/src/a.ts" }, { filediff: { file: "/w/src/a.ts", additions: 3, deletions: 1 } }))))
    .toEqual({ files: [{ path: "/w/src/a.ts", additions: 3, deletions: 1 }], additions: 3, deletions: 1 })
})

test("a patch sums every reported file and keeps each for the expansion", () => {
  const files = [{ relativePath: "src/a.ts", additions: 2, deletions: 0 }, { relativePath: "src/b.ts", additions: 5, deletions: 4 }]
  expect(editSummary(part("apply_patch", done({ patchText: "" }, { files })))).toEqual({
    files: [{ path: "src/a.ts", additions: 2, deletions: 0 }, { path: "src/b.ts", additions: 5, deletions: 4 }], additions: 7, deletions: 4,
  })
})

test("running, failed and metadata-less calls name files without counts, never zeros", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/c.ts\n+x\n*** End Patch"
  expect(editSummary(part("apply_patch", { status: "running", input: { patchText: patch }, time: { start: 1 } })))
    .toEqual({ files: [{ path: "src/a.ts" }, { path: "src/c.ts" }] })
  expect(editSummary(part("edit", { status: "error", input: { filePath: "/w/a.ts" }, error: "no match", time: { start: 1, end: 2 } })))
    .toEqual({ files: [{ path: "/w/a.ts" }] })
  expect(editSummary(part("write", done({ filePath: "/w/b.ts" }, {})))).toEqual({ files: [{ path: "/w/b.ts" }] })
  // One file without counts makes the total unknown rather than partial.
  expect(editSummary(part("apply_patch", done({}, { files: [{ relativePath: "a", additions: 1, deletions: 0 }, { relativePath: "b" }] }))))
    .toEqual({ files: [{ path: "a" }, { path: "b" }] })
})

test("other tools have no edit summary", () => {
  expect(editSummary(part("bash", done({ command: "ls" }, {})))).toBeUndefined()
})
