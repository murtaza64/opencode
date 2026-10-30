import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { callCard, shellProgram, toolGlyph } from "./tool-call"

const bash = (command: string) => toolGlyph("bash", { command }, "console")
// Unique IDs: finished-input sizes are cached per part ID.
let next = 0
const part = (state: ToolPart["state"]) => ({ id: `prt_card_${++next}`, sessionID: "ses", messageID: "msg", type: "tool", callID: `call_${next}`, tool: "bash", state }) as ToolPart

describe("tool glyphs", () => {
  test("a shell command gets the glyph for what it runs", () => {
    expect([bash("git status"), bash("rg -n foo src"), bash("cat a.ts"), bash("curl -s https://x"), bash("rm -rf dist"), bash("mkdir -p a")])
      .toEqual(["branch", "magnifying-glass", "glasses", "link", "trash", "folder"])
  })

  test("package runners read their subcommand: tests and installs, otherwise the shell icon", () => {
    expect([bash("bun test src/a.test.ts"), bash("node test/icon-chips.browser.mjs"), bash("npm install"), bash("bun run build"), bash("make lint")])
      .toEqual(["circle-check", "circle-check", "download", "console", "console"])
  })

  test("cd prefixes, env assignments and wrappers do not hide the program", () => {
    expect(shellProgram("cd packages/es-app && FOO=1 timeout 600 ~/.bun/bin/bun test x")).toEqual(["bun", "test", "x"])
    expect(bash("cd repo && sudo git log")).toBe("branch")
  })

  test("unknown commands and non-shell tools keep their own icon", () => {
    expect(bash("./deploy.sh")).toBe("console")
    expect(toolGlyph("read", { filePath: "a" }, "glasses")).toBe("glasses")
    expect(toolGlyph("bash", {}, "console")).toBe("console")
  })
})

describe("call card", () => {
  test("a finished call shows actual duration and labelled sizes, with its description", () => {
    const card = callCard(part({ status: "completed", input: { command: "bun test", description: "Unit tests" }, output: "o".repeat(1500), title: "", metadata: {}, time: { start: 1000, end: 3000 } }), "Shell", 0)
    expect(card).toMatchObject({ head: "Shell", description: "Unit tests", time: "2.0s", sizes: "input 18 chars · output 1.5k chars" })
    expect(card.label).toBe("Shell, Unit tests, 2.0s, input 18 chars · output 1.5k chars")
  })

  test("the card never repeats the command; without a description there is no description line", () => {
    const card = callCard(part({ status: "completed", input: { command: "ls" }, output: "a", title: "", metadata: {}, time: { start: 0, end: 5 } }), "Shell", 0)
    expect(card.description).toBe("")
    expect(card.label).not.toContain("ls")
  })

  test("a running call shows time so far and no output size yet", () => {
    const card = callCard(part({ status: "running", input: { command: "sleep 9" }, title: "", metadata: {}, time: { start: 1000 } }), "Shell", 13_000)
    expect(card).toMatchObject({ status: "unfinished", head: "Shell · running", time: "12s so far", sizes: "input 7 chars · output pending" })
  })

  test("a failed call says so, and its error text is labelled as error", () => {
    const card = callCard(part({ status: "error", input: { command: "false" }, error: "boom", metadata: {}, time: { start: 0, end: 10 } }), "Shell", 0)
    expect(card).toMatchObject({ head: "Shell · failed", sizes: "input 5 chars · error 4 chars", time: "10ms" })
  })
})
