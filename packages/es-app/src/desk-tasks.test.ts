import { expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import type { MessageWithParts } from "./api"
import { resultBody, TASK_CONTEXT_BUDGET, taskID, taskMeta, taskPacket, taskState, type TaskJob, type TaskMeta } from "./desk-tasks"

const meta: TaskMeta = { kind: "task", requestID: "msg_ask1", initiatingSession: "ses_desk", initiatingDirectory: "/root", packetSha256: "ab", contract: 1,
  question: "Which build is on the Mini?", asked: Date.UTC(2026, 9, 28, 7), packetBytes: 120 }
const user = { info: { id: "msg_u", role: "user" }, parts: [{ type: "text", text: "packet" }] }
const assistant = (text: string, extra: Record<string, unknown> = {}) =>
  ({ info: { id: "msg_a", role: "assistant", time: { created: 1, completed: 2 }, ...extra }, parts: [{ type: "text", text }] })

test("the same desk message always names the same task, and another message a different one", async () => {
  expect(await taskID("ses_fdbrief_a", "ses_desk", "msg_ask1")).toBe(await taskID("ses_fdbrief_a", "ses_desk", "msg_ask1"))
  expect(await taskID("ses_fdbrief_a", "ses_desk", "msg_ask1")).toMatch(/^ses_fdtask_[0-9a-f]{24}$/)
  expect(await taskID("ses_fdbrief_a", "ses_desk", "msg_ask2")).not.toBe(await taskID("ses_fdbrief_a", "ses_desk", "msg_ask1"))
  expect(await taskID("ses_fdbrief_a", "ses_other", "msg_ask1")).not.toBe(await taskID("ses_fdbrief_a", "ses_desk", "msg_ask1"))
})

test("a task starts from the question and a clipped view of the desk, never more than the budget", () => {
  const packet = taskPacket("  Which build?  ", "x".repeat(TASK_CONTEXT_BUDGET * 2))
  expect(packet.text.startsWith("Question: Which build?\n")).toBe(true)
  expect(packet.text.length).toBeLessThan(TASK_CONTEXT_BUDGET + 200)
  expect(packet.bytes).toBe(new TextEncoder().encode(packet.text).length)
})

test("only sessions carrying complete task metadata count as tasks", () => {
  const session = (frontDesk: unknown) => ({ id: "ses_fdtask_x", metadata: { frontDesk } }) as unknown as Session
  expect(taskMeta(session(meta))).toEqual(meta)
  expect(taskMeta(session({ ...meta, kind: "brief" }))).toBeUndefined()
  expect(taskMeta(session({ ...meta, initiatingSession: undefined }))).toBeUndefined()
})

test("task state follows its durable session: delegated, working, outcome text, failed, and stopped without rerun", () => {
  expect(taskState([user] as unknown as MessageWithParts[], "idle", 1_000)).toEqual({ state: "delegated" })
  expect(taskState([user] as unknown as MessageWithParts[], "busy")).toEqual({ state: "running" })
  expect(taskState([user, assistant("Build 42.")] as unknown as MessageWithParts[], "idle")).toEqual({ state: "ready", text: "Build 42." })
  expect(taskState([user, assistant("", { error: { name: "ProviderAuthError" } })] as unknown as MessageWithParts[], "idle")).toEqual({ state: "failed", error: "ProviderAuthError" })
  // Core restarted mid-turn: shown as stopped, never continued on its own.
  expect(taskState([user] as unknown as MessageWithParts[], "idle", 60_000)).toEqual({ state: "unknown", reason: "Task stopped before finishing." })
})

test("a finished task's result input is the same for every sender and namespaced apart from other inputs", () => {
  const job = { id: "ses_fdtask_1", directory: "/root", meta, created: 1, state: { state: "ready" as const, text: "Build 42 (see deploy.md)." } } satisfies TaskJob
  const first = resultBody(job)
  expect(resultBody(structuredClone(job))).toEqual(first)
  expect([first.requestID, first.delivery]).toEqual(["fdtask-result:ses_fdtask_1", "queue"])
  expect(first.text).toContain("Build 42 (see deploy.md).")
  expect(first.text).toContain("Which build is on the Mini?")
  // Sent by the task session in reply to the asking desk message, never as the human.
  expect(first.source).toEqual({ type: "editspace-mail", id: "fdtask-result:ses_fdtask_1", sender: "ses_fdtask_1", recipient: "ses_desk", kind: "task-result",
    senderSession: "ses_fdtask_1", relationship: "front-desk-task", in_reply_to: "msg_ask1" })
})

// The dashboard delivers the same body when no client is open
// (murtaza64/dotfiles bin/es_dashboard_frontdesk.py task_result_input, tests/test_es_dashboard_frontdesk.py).
test("the result body matches the dashboard's byte for byte", () => {
  const job = { id: "ses_fdtask_g", directory: "/root", created: 1, state: { state: "ready" as const, text: "Réponse 😀 line\nnext" },
    meta: { ...meta, question: `${"q".repeat(199)}😀tail`, asked: 1793170000123 } } satisfies TaskJob
  expect(new Bun.CryptoHasher("sha256").update(JSON.stringify(resultBody(job))).digest("hex")).toBe("ac12cd35046c0fc2e954e5d0e0e7ccac1c65d9540f4cc8f9683d0d503820f867")
})
