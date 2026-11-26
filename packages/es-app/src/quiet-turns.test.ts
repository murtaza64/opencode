import { expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { quietTurns } from "./quiet-turns"

let clock = 0
const human = (id: string) => ({ message: { id, role: "user", sessionID: "s", time: { created: ++clock } } as unknown as Message, parts: [text(id, "please do X")] })
const mail = (id: string) => ({ message: { id, role: "user", sessionID: "s", time: { created: ++clock }, source: { type: "editspace-mail", id: "m#1", sender: "a", recipient: "b" } } as unknown as Message, parts: [text(id, "mail body")] })
const wake = (id: string) => ({ message: { id, role: "user", sessionID: "s", time: { created: ++clock } } as unknown as Message, parts: [text(id, "Resume", true)] })
const reply = (id: string, parts: Part[], error?: object) => ({ message: { id, role: "assistant", sessionID: "s", time: { created: ++clock, completed: ++clock }, ...(error ? { error } : {}) } as unknown as Message, parts })
function text(id: string, value: string, synthetic = false) { return { id: `${id}_t`, type: "text", text: value, ...(synthetic ? { synthetic } : {}) } as unknown as Part }
const tool = (id: string) => ({ id: `${id}_c`, type: "tool", tool: "bash", state: { status: "completed" } }) as unknown as Part
const run = (rows: { message: Message; parts: Part[] }[], idle = true) => {
  const parts = new Map(rows.map((row) => [row.message.id, row.parts]))
  return quietTurns(rows.map((row) => row.message), (id) => parts.get(id) ?? [], idle)
}

test("a mail or wake turn that ends with no text is quiet; consecutive ones fold together", () => {
  const quiet = run([mail("u1"), reply("a1", [tool("a1")]), wake("u2"), reply("a2", [tool("a2")]), human("u3"), reply("a3", [text("a3", "done")])])
  expect(quiet.get("u1")).toMatchObject({ group: "u1", first: true, count: 2 })
  expect([...quiet.keys()]).toEqual(["u1", "a1", "u2", "a2"])
})

test("a reply with text, an error, or a human prompt's turn is never quiet", () => {
  expect(run([mail("u1"), reply("a1", [tool("a1"), text("a1", "Review ready")])]).size).toBe(0)
  expect(run([mail("u1"), reply("a1", [tool("a1")], { name: "APIError" })]).size).toBe(0)
  expect(run([human("u1"), reply("a1", [tool("a1")])]).size).toBe(0)
})

test("the newest turn folds only once the session is idle", () => {
  expect(run([mail("u1"), reply("a1", [tool("a1")])], false).size).toBe(0)
  expect(run([mail("u1"), reply("a1", [tool("a1")])], true).size).toBe(2)
})
