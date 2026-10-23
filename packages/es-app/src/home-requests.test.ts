import { expect, test } from "bun:test"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { editFiles, requestLive, type HomeRequestRow } from "./home-requests"

const edit = (metadata: Record<string, unknown>, patterns = ["runtime-options/REPLACEMENT.md"]) =>
  ({ id: "per_1", sessionID: "ses_1", permission: "edit", patterns, always: ["*"], metadata }) as PermissionRequest
const patch = "Index: /r/runtime-options/REPLACEMENT.md\n===================================================================\n--- /r/runtime-options/REPLACEMENT.md\n+++ /r/runtime-options/REPLACEMENT.md\n@@ -1,3 +1,3 @@\n # Title\n-old line\n+new line\n+another\n"

test("an edit permission yields its project-relative path, full path and line counts", () => {
  expect(editFiles(edit({ filepath: "/r/runtime-options/REPLACEMENT.md", diff: patch }))).toEqual([
    { path: "runtime-options/REPLACEMENT.md", full: "/r/runtime-options/REPLACEMENT.md", patch, additions: 2, deletions: 1 },
  ])
})

test("an apply_patch permission yields one entry per file, keeping type and producer counts", () => {
  const files = editFiles(edit({ filepath: "a.ts, b.ts", diff: "x", files: [
    { filePath: "/r/a.ts", relativePath: "a.ts", type: "add", patch: "@@ -0,0 +1 @@\n+x\n", additions: 1, deletions: 0 },
    { filePath: "/r/old.ts", relativePath: "b.ts", type: "move", movePath: "/r/b.ts", patch: "", additions: 0, deletions: 0 },
    { relativePath: 7 },
  ] }, ["a.ts", "b.ts"]))
  expect(files.map(file => [file.path, file.type, file.additions, file.deletions, file.full])).toEqual([
    ["a.ts", "add", 1, 0, "/r/a.ts"],
    ["b.ts", "move", 0, 0, "/r/old.ts"],
  ])
})

test("non-edit permissions and edits without a diff have no edit files", () => {
  expect(editFiles({ ...edit({ command: "ls" }), permission: "bash" })).toEqual([])
  expect(editFiles(edit({ filepath: "/r/x" }))).toEqual([])
  expect(editFiles(undefined)).toEqual([])
})

const row = (state: HomeRequestRow["state"]): HomeRequestRow => ({ kind: "permission", id: "per_1", session: "ses_1", directory: "/r", title: "t", state, checked: 1 })

test("a queued request is waiting unless a settled event or snapshot says it cleared", () => {
  expect(requestLive(true, row("pending"), [row("pending")], "pending")).toBe("pending")
  expect(requestLive(true, row("pending"), [row("pending")], "unknown")).toBe("pending")
  expect(requestLive(true, row("pending"), [row("pending")], "cleared")).toBe("cleared")
})

test("a request that left the queue is never assumed waiting; only a checked source clears it", () => {
  expect(requestLive(false, row("pending"), [row("unavailable")], "pending")).toBe("unavailable")
  expect(requestLive(false, row("pending"), [row("unknown")], "pending")).toBe("cleared")
  expect(requestLive(false, row("pending"), [], "unknown")).toBe("unknown")
  expect(requestLive(false, row("pending"), [], "pending")).toBe("unknown")
})
