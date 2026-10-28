import { describe, expect, test } from "bun:test"
import { commandKind } from "./command-kind"

describe("commandKind", () => {
  test("plain programs", () => {
    expect(commandKind("git status")).toBe("git")
    expect(commandKind("jj log -r @")).toBe("jj")
    expect(commandKind("gh pr create --title x")).toBe("gh")
    expect(commandKind("es mail check")).toBe("es")
    expect(commandKind("aws s3 ls")).toBe("aws")
    expect(commandKind("bun test src/filament")).toBe("test")
    expect(commandKind("curl -s http://x")).toBe("http")
    expect(commandKind("docker ps")).toBe("container")
    expect(commandKind("rg foo packages")).toBe("search")
    expect(commandKind("make build")).toBe("build")
    expect(commandKind("echo hi")).toBe("shell")
  })
  test("skips cd prefixes, env assignments, wrappers and paths", () => {
    expect(commandKind("cd packages/es-app && bun typecheck")).toBe("test")
    expect(commandKind("PORT=4877 nohup bun serve.ts")).toBe("test")
    expect(commandKind("sudo /usr/bin/git fetch")).toBe("git")
    expect(commandKind("(cd /tmp; jj new)")).toBe("jj")
  })
  test("first program in a pipeline wins", () => {
    expect(commandKind("git log | head -3")).toBe("git")
    expect(commandKind("cat f | rg x")).toBe("search")
  })
  test("empty or missing is shell", () => {
    expect(commandKind(undefined)).toBe("shell")
    expect(commandKind("   ")).toBe("shell")
  })
})
