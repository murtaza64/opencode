import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionSupersession } from "@/session/supersession"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(httpApiLayer, AppNodeBuilder.build(LayerNode.group([Session.node, SessionPrompt.node, SessionRunState.node, SessionSupersession.node])), AppNodeBuilder.build(CrossSpawnSpawner.node), TestLLMServer.layer))

it.live("idle supersession is durable, idempotent and rejects every legacy writer while preserving reads", () =>
  provideTmpdirServer(({ dir, llm }) => Effect.gen(function* () {
    const original = yield* Session.use.create({ title: "Original", metadata: { preserved: true } })
    const successor = yield* Session.use.create({ title: "Successor" })
    const different = yield* Session.use.create({ title: "Different" })
    const url = `/session/${original.id}`
    const post = (suffix: string, body: unknown) => requestInDirectory(`${url}/${suffix}`, dir, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })
    const committed = yield* post("supersede", { successor: successor.id })
    expect(committed.status).toBe(200)
    expect(yield* committed.json).toEqual({ sessionID: original.id, successor: successor.id, state: "committed" })
    expect(yield* (yield* post("supersede", { successor: successor.id })).json).toEqual({ sessionID: original.id, successor: successor.id, state: "committed" })
    expect(yield* (yield* post("supersede", { successor: different.id })).json).toMatchObject({ _tag: "SessionSupersededError", successor: successor.id })
    const prompt = { agent: "build", model: { providerID: "test", modelID: "test-model" }, parts: [{ type: "text", text: "old writer" }] }
    for (const [suffix, body] of [
      ["input", { requestID: "old-input", delivery: "queue", text: "old writer" }],
      ["message", { ...prompt, noReply: true }],
      ["prompt_async", prompt],
      ["command", { command: "init", arguments: "" }],
      ["shell", { agent: "build", command: "printf should-not-execute" }],
      ["summarize", { providerID: "test", modelID: "test-model" }],
    ] as const) {
      const response = yield* post(suffix, body)
      expect(response.status).toBe(409)
      expect(yield* response.json).toMatchObject({ _tag: "SessionSupersededError", sessionID: original.id, successor: successor.id, state: "committed" })
    }
    const promptSvc = yield* SessionPrompt.Service
    const run = yield* SessionRunState.Service
    expect((yield* Effect.flip(promptSvc.wake(original.id))).successor).toBe(successor.id)
    expect((yield* Effect.flip(run.ensureRunning(original.id, Effect.die("unexpected"), Effect.die("unexpected")))).successor).toBe(successor.id)
    expect(yield* (yield* requestInDirectory(url, dir)).json).toMatchObject({ metadata: { preserved: true } })
    const patched = yield* requestInDirectory(url, dir, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { updated: true } }),
    })
    expect(patched.status).toBe(200)
    expect(yield* patched.json).toMatchObject({ metadata: { updated: true } })
    expect((yield* post("input", { requestID: "after-patch", delivery: "queue", text: "still closed" })).status).toBe(409)
    expect((yield* requestInDirectory(`${url}/message`, dir)).status).toBe(200)
    expect(yield* llm.inputs).toHaveLength(0)
  }), { config: testProviderConfig }), 30_000)

it.live("busy supersession waits for provider completion and rejects concurrent admission without cancelling it", () =>
  provideTmpdirServer(({ dir, llm }) => Effect.gen(function* () {
    const held = Promise.withResolvers<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
    yield* llm.push(reply().text("finishes safely").wait(held.promise).stop())
    const original = yield* Session.use.create({ title: "Working" })
    const successor = yield* Session.use.create({ title: "After" })
    const url = `/session/${original.id}`
    const post = (suffix: string, body: unknown) => requestInDirectory(`${url}/${suffix}`, dir, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })
    expect((yield* post("prompt_async", { agent: "build", model: { providerID: "test", modelID: "test-model" }, parts: [{ type: "text", text: "first" }] })).status).toBe(204)
    yield* llm.wait(1)
    const pending = yield* post("supersede", { successor: successor.id })
    expect(pending.status).toBe(200)
    expect(yield* pending.json).toEqual({ sessionID: original.id, successor: successor.id, state: "pending" })
    const rejected = yield* post("input", { requestID: "blocked", delivery: "steer", text: "no second turn" })
    expect(rejected.status).toBe(409)
    expect(yield* rejected.json).toMatchObject({ successor: successor.id, state: "pending" })
    held.resolve()
    yield* pollWithTimeout(Effect.gen(function* () {
      const receipt = yield* post("supersede", { successor: successor.id })
      const body = yield* receipt.json
      return typeof body === "object" && body !== null && "state" in body && body.state === "committed" ? true : undefined
    }), "supersession did not commit on idle", "10 seconds")
    expect(yield* llm.inputs).toHaveLength(1)
    const transcript = yield* (yield* requestInDirectory(`${url}/message`, dir)).json
    expect(JSON.stringify(transcript)).toContain("finishes safely")
    expect(JSON.stringify(transcript)).not.toContain("no second turn")
    yield* llm.text("successor response")
    const next = yield* requestInDirectory(`/session/${successor.id}/message`, dir, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "build", model: { providerID: "test", modelID: "test-model" }, parts: [{ type: "text", text: "successor prompt" }] }),
    })
    expect(next.status).toBe(200)
    expect(yield* llm.inputs).toHaveLength(2)
  }), { config: testProviderConfig }), 30_000)

it.live("a pending durable fence left by a stopped process commits before a new runner can start", () =>
  provideTmpdirServer(({ dir, llm }) => Effect.gen(function* () {
    const predecessor = yield* Session.use.create({ title: "Previously busy" })
    const successor = yield* Session.use.create({ title: "New owner" })
    const supersession = yield* SessionSupersession.Service
    const run = yield* SessionRunState.Service
    expect((yield* supersession.request(predecessor.id, successor.id)).state).toBe("pending")
    const denied = yield* Effect.flip(run.ensureRunning(predecessor.id, Effect.die("old interrupt"), Effect.die("old provider")))
    expect(denied).toMatchObject({ successor: successor.id, state: "committed" })
    expect(yield* supersession.get(predecessor.id)).toEqual({ sessionID: predecessor.id, successor: successor.id, state: "committed" })
    const retry = yield* requestInDirectory(`/session/${predecessor.id}/supersede`, dir, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ successor: successor.id }),
    })
    expect(retry.status).toBe(200)
    expect(yield* retry.json).toMatchObject({ state: "committed" })
    expect(yield* llm.inputs).toHaveLength(0)
  }), { config: testProviderConfig }), 20_000)

it.live("busy supersession lets an already admitted tool finish before committing", () =>
  provideTmpdirServer(({ dir, llm }) => Effect.gen(function* () {
    const held = Promise.withResolvers<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
    yield* llm.push(reply().tool("bash", { command: "printf tool-completed", description: "Complete current tool" }).wait(held.promise).item())
    yield* llm.text("done after tool")
    const predecessor = yield* Session.use.create({ title: "Tool in progress", permission: [{ permission: "bash", pattern: "*", action: "allow" }] })
    const successor = yield* Session.use.create({ title: "New owner" })
    const post = (suffix: string, body: unknown) => requestInDirectory(`/session/${predecessor.id}/${suffix}`, dir, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })
    expect((yield* post("prompt_async", { agent: "build", model: { providerID: "test", modelID: "test-model" }, parts: [{ type: "text", text: "run tool" }] })).status).toBe(204)
    yield* llm.wait(1)
    expect(yield* (yield* post("supersede", { successor: successor.id })).json).toMatchObject({ state: "pending" })
    held.resolve()
    yield* llm.wait(2)
    yield* pollWithTimeout(Effect.gen(function* () {
      const result = yield* (yield* post("supersede", { successor: successor.id })).json
      return typeof result === "object" && result !== null && "state" in result && result.state === "committed" ? true : undefined
    }), "tool drain did not reach idle", "10 seconds")
    const transcript = yield* (yield* requestInDirectory(`/session/${predecessor.id}/message`, dir)).json
    expect(JSON.stringify(transcript)).toContain("tool-completed")
    expect(JSON.stringify(transcript)).toContain("done after tool")
    expect(yield* llm.inputs).toHaveLength(2)
  }), { config: testProviderConfig }), 30_000)

it.live("concurrent input and fence never start predecessor work after commit", () =>
  provideTmpdirServer(({ dir, llm }) => Effect.gen(function* () {
    yield* llm.text("accepted before fence")
    const predecessor = yield* Session.use.create({ title: "Racing" })
    const successor = yield* Session.use.create({ title: "Winner" })
    const post = (suffix: string, body: unknown) => requestInDirectory(`/session/${predecessor.id}/${suffix}`, dir, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })
    const [input, fence] = yield* Effect.all([
      post("input", { requestID: "racing-input", delivery: "queue", text: "before or blocked" }),
      post("supersede", { successor: successor.id }),
    ], { concurrency: 2 })
    expect([200, 409]).toContain(input.status)
    expect(fence.status).toBe(200)
    yield* pollWithTimeout(Effect.gen(function* () {
      const response = yield* post("supersede", { successor: successor.id })
      const body = yield* response.json
      return typeof body === "object" && body !== null && "state" in body && body.state === "committed" ? true : undefined
    }), "fence did not commit", "10 seconds")
    const calls = (yield* llm.inputs).length
    expect((yield* post("prompt_async", { agent: "build", model: { providerID: "test", modelID: "test-model" }, parts: [{ type: "text", text: "after commit" }] })).status).toBe(409)
    expect((yield* llm.inputs).length).toBe(calls)
  }), { config: testProviderConfig }), 25_000)

it.live("a pending fence can be cancelled to reopen the predecessor, while a committed fence is final", () =>
  provideTmpdirServer(({ dir, llm }) => Effect.gen(function* () {
    const original = yield* Session.use.create({ title: "Abandoned handoff" })
    const successor = yield* Session.use.create({ title: "Never started" })
    const supersession = yield* SessionSupersession.Service
    const run = yield* SessionRunState.Service
    const cancel = () => requestInDirectory(`/session/${original.id}/supersede`, dir, { method: "DELETE" })
    expect((yield* cancel()).status).toBe(404)
    // Request directly: an idle admission would commit the fence, which is exactly what an abandoned handoff must avoid.
    expect((yield* supersession.request(original.id, successor.id)).state).toBe("pending")
    const cancelled = yield* cancel()
    expect(cancelled.status).toBe(200)
    expect(yield* cancelled.json).toEqual({ sessionID: original.id, successor: successor.id, state: "pending" })
    expect(yield* supersession.get(original.id)).toBeUndefined()
    expect(yield* run.admit(original.id, Effect.succeed("reopened"))).toBe("reopened")
    expect((yield* cancel()).status).toBe(404)
    const committed = yield* requestInDirectory(`/session/${original.id}/supersede`, dir, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ successor: successor.id }),
    })
    expect(yield* committed.json).toMatchObject({ state: "committed" })
    const final = yield* cancel()
    expect(final.status).toBe(409)
    expect(yield* final.json).toMatchObject({ _tag: "SessionSupersededError", successor: successor.id, state: "committed" })
    expect((yield* Effect.flip(run.admit(original.id, Effect.succeed("still closed")))).state).toBe("committed")
    expect(yield* llm.inputs).toHaveLength(0)
  }), { config: testProviderConfig }), 20_000)

it.live("cancelling a busy pending fence lets the predecessor accept work after its turn settles", () =>
  provideTmpdirServer(({ dir, llm }) => Effect.gen(function* () {
    const held = Promise.withResolvers<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
    yield* llm.push(reply().text("first turn").wait(held.promise).stop())
    yield* llm.text("second turn")
    const original = yield* Session.use.create({ title: "Busy then reopened" })
    const successor = yield* Session.use.create({ title: "Abandoned" })
    const supersession = yield* SessionSupersession.Service
    const post = (suffix: string, body: unknown) => requestInDirectory(`/session/${original.id}/${suffix}`, dir, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })
    expect((yield* post("prompt_async", { agent: "build", model: { providerID: "test", modelID: "test-model" }, parts: [{ type: "text", text: "first" }] })).status).toBe(204)
    yield* llm.wait(1)
    expect(yield* (yield* post("supersede", { successor: successor.id })).json).toMatchObject({ state: "pending" })
    const cancelled = yield* requestInDirectory(`/session/${original.id}/supersede`, dir, { method: "DELETE" })
    expect(cancelled.status).toBe(200)
    expect(yield* cancelled.json).toMatchObject({ state: "pending" })
    held.resolve()
    yield* pollWithTimeout(Effect.gen(function* () {
      const body = yield* (yield* requestInDirectory(`/session/status`, dir)).json
      const status = body as Record<string, { type: string }>
      return status[original.id] === undefined || status[original.id]?.type === "idle" ? true : undefined
    }), "predecessor did not settle", "10 seconds")
    expect(yield* supersession.get(original.id)).toBeUndefined()
    expect((yield* post("input", { requestID: "after-cancel", delivery: "queue", text: "second" })).status).toBe(200)
    yield* llm.wait(2)
    expect(yield* llm.inputs).toHaveLength(2)
  }), { config: testProviderConfig }), 30_000)

it.live("deleting a fenced successor is refused until its predecessor is gone", () =>
  provideTmpdirServer(({ dir }) => Effect.gen(function* () {
    const original = yield* Session.use.create({ title: "Predecessor" })
    const successor = yield* Session.use.create({ title: "Successor" })
    const supersession = yield* SessionSupersession.Service
    const remove = (id: string) => requestInDirectory(`/session/${id}`, dir, { method: "DELETE" })
    expect((yield* supersession.request(original.id, successor.id)).state).toBe("pending")
    const pending = yield* remove(successor.id)
    expect(pending.status).toBe(409)
    expect(yield* pending.json).toMatchObject({ _tag: "ConflictError", resource: original.id })
    yield* supersession.commit(original.id)
    const committed = yield* remove(successor.id)
    expect(committed.status).toBe(409)
    expect(yield* pending.json).toMatchObject({ _tag: "ConflictError", resource: original.id })
    expect((yield* requestInDirectory(`/session/${successor.id}`, dir)).status).toBe(200)
    expect((yield* remove(original.id)).status).toBe(200)
    expect((yield* remove(successor.id)).status).toBe(200)
    expect((yield* requestInDirectory(`/session/${successor.id}`, dir)).status).toBe(404)
  }), { config: testProviderConfig }), 20_000)
