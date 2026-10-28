import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Session } from "@/session/session"
import { provideTmpdirServer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Front Desk task transport (dotfiles#238): the desk records the human's task question with noReply,
// a task result returns as one sourced queue input, and an amendment steers the task session.

const it = testEffect(
  Layer.mergeAll(httpApiLayer, AppNodeBuilder.build(Session.node), AppNodeBuilder.build(CrossSpawnSpawner.node), TestLLMServer.layer),
)

const model = { providerID: "test", modelID: "test-model" }
const QUESTION = "msg_ffffffffff01DeskTaskQuestion"
const texts = (messages: any[]) =>
  messages.map((m) => [m.info.role, m.parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("")])

const tools = (dir: string, sessionID: string) => ({
  post: (path: string, body: unknown) =>
    requestInDirectory(`/session/${sessionID}${path}`, dir, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  messages: () => requestInDirectory(`/session/${sessionID}/message`, dir).pipe(Effect.flatMap((r) => r.json)) as Effect.Effect<any[]>,
  receipt: (requestID: string) =>
    requestInDirectory(`/session/${sessionID}/input/${encodeURIComponent(requestID)}`, dir).pipe(Effect.flatMap((r) => r.json)) as Effect.Effect<any>,
})

const result = (desk: string) => ({
  requestID: "fdtask-result:ses_fdtask_0123456789abcdef01234567",
  delivery: "queue",
  text: "Task result: 3 PRs",
  source: {
    type: "editspace-mail", id: "fdtask-result:ses_fdtask_0123456789abcdef01234567",
    sender: "ses_fdtask_0123456789abcdef01234567", senderSession: "ses_fdtask_0123456789abcdef01234567",
    recipient: desk, kind: "task-result", relationship: "front-desk-task", in_reply_to: QUESTION,
  },
})

it.live(
  "a noReply message recorded during a running turn is not answered by that turn",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const held = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
          yield* llm.push(reply().text("desk first answer").wait(held.promise).stop())
          yield* llm.push(reply().text("DUPLICATE desk reply").stop())
          const desk = yield* Session.use.create({ title: "Desk", agent: "build" })
          const api = tools(dir, desk.id)
          yield* api.post("/prompt_async", { agent: "build", model, parts: [{ type: "text", text: "first chat" }] })
          yield* llm.wait(1)
          const recorded = yield* api.post("/prompt_async", {
            agent: "build", model, noReply: true, messageID: QUESTION, parts: [{ type: "text", text: "TASK QUESTION" }],
          })
          expect(recorded.status).toBe(204)
          held.resolve()
          yield* pollWithTimeout(
            api.messages().pipe(Effect.map((all) => (all.some((m) => m.info.role === "assistant" && m.info.time?.completed) ? all : undefined))),
            "first desk turn did not finish", "10 seconds")
          yield* Effect.sleep("1 second")
          expect(texts(yield* api.messages())).toEqual([
            ["user", "first chat"], ["assistant", "desk first answer"], ["user", "TASK QUESTION"],
          ])
          expect(yield* llm.inputs).toHaveLength(1)
        }),
      { config: testProviderConfig },
    ),
  30_000,
)

it.live(
  "after a noReply question the next chat and a queued task result each run one turn",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.push(reply().text("chat answer").stop())
          yield* llm.push(reply().text("result seen").stop())
          const desk = yield* Session.use.create({ title: "Desk", agent: "build" })
          const api = tools(dir, desk.id)
          expect((yield* api.post("/prompt_async", {
            agent: "build", model, noReply: true, messageID: QUESTION, parts: [{ type: "text", text: "TASK QUESTION" }],
          })).status).toBe(204)
          yield* Effect.sleep("500 millis")
          expect(yield* llm.inputs).toHaveLength(0)
          yield* api.post("/prompt_async", { agent: "build", model, parts: [{ type: "text", text: "next chat" }] })
          yield* llm.wait(1)
          yield* pollWithTimeout(
            api.messages().pipe(Effect.map((all) => (all.at(-1)?.info.role === "assistant" && all.at(-1)?.info.time?.completed ? all : undefined))),
            "chat turn did not finish", "10 seconds")
          expect((yield* api.post("/input", result(desk.id))).status).toBe(200)
          yield* llm.wait(2)
          yield* Effect.sleep("500 millis")
          expect(yield* llm.inputs).toHaveLength(2)
          expect(texts(yield* api.messages()).map((t) => t[1])).toEqual(["TASK QUESTION", "next chat", "chat answer", "Task result: 3 PRs", "result seen"])
        }),
      { config: testProviderConfig },
    ),
  30_000,
)

it.live(
  "a sourced task result keeps its origin, reconciles an exact retry and refuses a changed payload",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.push(reply().text("result seen").stop())
          const desk = yield* Session.use.create({ title: "Desk", agent: "build" })
          const api = tools(dir, desk.id)
          const input = result(desk.id)
          expect((yield* api.post("/input", input)).status).toBe(200)
          expect((yield* api.post("/input", input)).status).toBe(200)
          expect((yield* api.post("/input", { ...input, text: "Task result: 4 PRs" })).status).toBe(409)
          const promoted = yield* pollWithTimeout(
            api.receipt(input.requestID).pipe(Effect.map((r) => (r.state === "promoted" ? r : undefined))), "result not promoted", "10 seconds")
          const message = (yield* api.messages()).find((m) => m.info.id === promoted.messageID)
          expect(message.info.source).toEqual(input.source)
          expect(message.parts.filter((p: any) => p.type === "text").map((p: any) => p.text)).toEqual(["Task result: 3 PRs"])
        }),
      { config: testProviderConfig },
    ),
  30_000,
)

it.live(
  "an amendment steers a busy task session once and refuses a changed delivery",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const held = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
          yield* llm.push(reply().text("task working").wait(held.promise).stop())
          yield* llm.push(reply().text("task amended answer").stop())
          const task = yield* Session.use.create({ title: "Task", agent: "build" })
          const api = tools(dir, task.id)
          yield* api.post("/prompt_async", { agent: "build", model, parts: [{ type: "text", text: "task: list PRs" }] })
          yield* llm.wait(1)
          const amend = {
            requestID: "fdtask-amend:msg_ffffffffff02DeskAmend", delivery: "steer", text: "Amendment: include drafts",
            source: { type: "editspace-mail", id: "fdtask-amend:msg_ffffffffff02DeskAmend", sender: "ses_desk", senderSession: "ses_desk",
              recipient: task.id, kind: "task-amendment", relationship: "front-desk-task", in_reply_to: "msg_ffffffffff02DeskAmend" },
          }
          expect((yield* api.post("/input", amend)).status).toBe(200)
          expect((yield* api.post("/input", amend)).status).toBe(200)
          expect((yield* api.post("/input", { ...amend, delivery: "queue" })).status).toBe(409)
          held.resolve()
          yield* llm.wait(2)
          yield* pollWithTimeout(api.receipt(amend.requestID).pipe(Effect.map((r) => (r.state === "presented" ? r : undefined))),
            "amendment not presented", "10 seconds")
          expect(yield* llm.inputs).toHaveLength(2)
        }),
      { config: testProviderConfig },
    ),
  30_000,
)
