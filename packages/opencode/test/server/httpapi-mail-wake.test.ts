import { afterAll, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import { Effect, Layer, Schema, Scope } from "effect"
import { HttpServer } from "effect/unstable/http"

const cli = process.env.ES_MAIL_TEST_CLI
if (!cli) test.skip("actual es CLI (set ES_MAIL_TEST_CLI)", () => {})
else {
  // Run this fixture in its own Bun process: Database.node captures its filename
  // on import. Establish the private DB before importing the production graph.
  const root = await mkdtemp(path.join(tmpdir(), "opencode-mail-wake-"))
  const previousDB = process.env.OPENCODE_DB
  process.env.OPENCODE_DB = path.join(root, "runtime.sqlite3")
  const { AppNodeBuilder } = await import("@opencode-ai/core/effect/app-node-builder")
  const { LayerNode } = await import("@opencode-ai/core/effect/layer-node")
  const { Session } = await import("@/session/session")
  const { SessionRunState } = await import("@/session/run-state")
  const { SessionInput } = await import("@/session/input")
  const { SessionStatus } = await import("@/session/status")
  const { MessageID } = await import("@/session/schema")
  const { ProviderV2 } = await import("@opencode-ai/core/provider")
  const { ModelV2 } = await import("@opencode-ai/core/model")
  const { SessionV1 } = await import("@opencode-ai/core/v1/session")
  const { provideInstance, testInstanceStoreLayer } = await import("../fixture/fixture")
  const { pollWithTimeout, testEffect } = await import("../lib/effect")
  const { httpApiLayer, requestInDirectory } = await import("./httpapi-layer")

  const it = testEffect(Layer.mergeAll(
    httpApiLayer,
    AppNodeBuilder.build(LayerNode.group([Session.node, SessionInput.node, SessionRunState.node, SessionStatus.node])),
    testInstanceStoreLayer,
  ))

  afterAll(async () => {
    const { disposeAllInstances } = await import("../fixture/fixture")
    await disposeAllInstances()
    await rm(root, { recursive: true, force: true })
    if (previousDB === undefined) delete process.env.OPENCODE_DB
    else process.env.OPENCODE_DB = previousDB
  }, 20_000)

  it.live(
    "actual mail send observes idle scheduling, active coalescing and exact retry after a lost ACK",
    () =>
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer
        if (server.address._tag !== "TcpAddress" || server.address.port <= 0) throw new Error("expected ephemeral TCP server")
        // layerTest may bind an unspecified interface; CLI is restricted to loopback.
        const url = `http://127.0.0.1:${server.address.port}`
        expect(new URL(url).hostname).toBe("127.0.0.1")
         expect(process.env.OPENCODE_DB).toBe(path.join(root, "runtime.sqlite3"))
         expect(Bun.file(path.join(root, "runtime.sqlite3")).size).toBeGreaterThan(0)
        const editspace = path.join(root, "editspaces", "private")
        const receiver = path.join(editspace, "lanes", "receiver")
        const home = path.join(root, "home")
        yield* Effect.promise(() => Promise.all([mkdir(receiver, { recursive: true }), mkdir(home, { recursive: true })]))
        yield* Effect.promise(() => writeFile(path.join(receiver, "LANE.md"), "# Lane: receiver\nowner: ses_placeholder\nstatus: active\n"))
        const session = yield* provideInstance(receiver)(
          Effect.gen(function* () {
            const session = yield* Session.use.create({
              title: "Private mail recipient",
              agent: "build",
              model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test") },
            })
            // Advisory wake can be scheduled, but unfinished history must not
            // resume provider work after a crash.
            yield* Session.use.updateMessage({
              id: MessageID.ascending(), sessionID: session.id, role: "user", agent: "build",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
              time: { created: Date.now() },
            })
            return session
          }),
        )
        yield* Effect.promise(() => writeFile(path.join(receiver, "LANE.md"), `# Lane: receiver\nowner: ${session.id}\nstatus: active\n`))

        const send = (requestID: string, target = url) =>
          Effect.promise(async () => {
            const child = Bun.spawn({
              cmd: ["uv", "run", "--no-project", "--script", "--quiet", cli,
                "--editspace", "private", "mail", "send", "--kind", "task", "--to", "receiver",
                "--request-id", requestID, "--json", "Private task"],
              cwd: editspace,
              env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
                XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_CACHE_HOME: path.join(home, ".cache"),
                UV_PROJECT_ENVIRONMENT: path.join(root, "venv"), UV_CACHE_DIR: path.join(root, "uv-cache"),
                UV_FROZEN: "1", EDITSPACES_ROOT: path.join(root, "editspaces"),
                REPO_CACHE_ROOT: path.join(root, "cache"), EDITSPACE_AGENT_ID: "test-agent", OPENCODE_URL: target },
              stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(20_000),
            })
            const [stdout, stderr, exit] = await Promise.all([
              new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
            ])
            expect(exit, stderr).toBe(0)
            return JSON.parse(stdout) as {
              id: string
              deliveries: Array<{ request_id: string; session: string; state: string; error: string | null; wake_observations?: readonly unknown[] }>
            }
          })
        const receipt = (id: string) => requestInDirectory(`/session/${session.id}/input/${id}`, receiver).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(SessionV1.InputReceipt)),
        )
        const idle = yield* send("idle")
        expect(idle.deliveries).toMatchObject([{ session: session.id, state: "admitted", error: null }])
        const first = yield* receipt(idle.deliveries[0]!.request_id)
         expect(first).toMatchObject({ state: "pending", source: { type: "editspace-mail", id: idle.id,
           recipient: "receiver" }, wakeObservations: [{ outcome: "scheduled", observedAt: expect.any(Number) }] })
         expect(idle.deliveries[0]?.wake_observations).toEqual(first.wakeObservations)
        expect((yield* receipt(first.requestID)).wakeObservations).toEqual(first.wakeObservations)
        expect(yield* Effect.promise(() => readFile(path.join(editspace, ".es", "mail", "receiver.jsonl"), "utf8")))
          .toContain(idle.id)

        // Real RunState ownership, but controlled held work: zero LLM calls.
        const scope = yield* Scope.Scope
        yield* provideInstance(receiver)(SessionRunState.Service.use((state) =>
          state.startShell(session.id, Effect.never, Effect.never).pipe(Effect.forkIn(scope))))
        yield* pollWithTimeout(
          provideInstance(receiver)(SessionStatus.Service.use((status) => status.get(session.id))).pipe(
            Effect.map((status) => status.type === "busy" ? true : undefined)),
          "held runner did not become busy", "10 seconds",
        )
        yield* Effect.addFinalizer(() => provideInstance(receiver)(SessionRunState.Service.use((state) => state.cancel(session.id))))
        const active = yield* send("active")
        const coalesced = yield* receipt(active.deliveries[0]!.request_id)
         expect(coalesced).toMatchObject({ state: "pending", wakeObservations: [{ outcome: "coalesced",
           observedAt: expect.any(Number) }] })
         expect(active.deliveries[0]?.wake_observations).toEqual(coalesced.wakeObservations)
        expect((yield* receipt(coalesced.requestID)).wakeObservations).toEqual(coalesced.wakeObservations)

        // The proxy forwards the real POST and discards its response once the
        // runtime has committed. Retrying the same CLI send must read/re-POST
        // the existing input, never create another message or lose observation 1.
        let dropped = false
        const proxy = createServer(async (req, res) => {
          const body = Buffer.concat(await Array.fromAsync(req))
          const response = await fetch(new URL(req.url ?? "/", url), {
            method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" },
            body: req.method === "POST" ? body : undefined,
          })
          if (req.method === "POST" && !dropped && req.url?.includes("/input?")) {
            dropped = true
            req.socket.destroy()
            return
          }
          res.writeHead(response.status, Object.fromEntries(response.headers))
          res.end(Buffer.from(await response.arrayBuffer()))
        })
        yield* Effect.promise(() => new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve)))
        yield* Effect.addFinalizer(() => Effect.promise(() => new Promise<void>((resolve) => proxy.close(() => resolve()))))
        const address = proxy.address()
        if (!address || typeof address === "string") throw new Error("proxy must bind TCP")
        const lost = yield* send("lost-ack", `http://127.0.0.1:${address.port}`)
        expect(dropped).toBe(true)
         expect(lost.deliveries).toMatchObject([{ state: "failed" }])
         expect(lost.deliveries[0]?.wake_observations).toBeUndefined()
        const committed = yield* receipt(lost.deliveries[0]!.request_id)
        expect(committed.wakeObservations).toMatchObject([{ outcome: "coalesced" }])
        const retry = yield* send("lost-ack")
        expect(retry.id).toBe(lost.id)
        expect(retry.deliveries).toMatchObject([{ state: "admitted", request_id: committed.requestID }])
        const recovered = yield* receipt(committed.requestID)
        expect(recovered.wakeObservations).toHaveLength(2)
        expect(recovered.wakeObservations?.[0]).toEqual(committed.wakeObservations?.[0])
         expect(recovered.wakeObservations?.[1]).toMatchObject({ outcome: "coalesced", observedAt: expect.any(Number) })
         expect(retry.deliveries[0]?.wake_observations).toEqual(recovered.wakeObservations)
        expect((yield* receipt(committed.requestID)).wakeObservations).toEqual(recovered.wakeObservations)
        const messages = yield* requestInDirectory(`/session/${session.id}/message`, receiver).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts))),
        )
        expect(messages).toHaveLength(1)
        expect(messages[0]?.info.role).toBe("user")
         const pending = yield* requestInDirectory(`/session/${session.id}/input`, receiver)
         expect(yield* pending.json)
          .toMatchObject({ items: [{ requestID: first.requestID }, { requestID: coalesced.requestID },
            { requestID: recovered.requestID }] })
        expect((yield* Effect.promise(() => readFile(path.join(editspace, ".es", "mail", "receiver.jsonl"), "utf8"))).trim().split("\n"))
          .toHaveLength(3)

        // Model the crash window after durable admission but before wake observation.
        // A GET is evidence only of admission; it must not invent a scheduling outcome.
        const gap = { requestID: "crash-gap", delivery: "queue" as const, text: "Unobserved mail",
          source: { type: "editspace-mail" as const, id: "receiver#gap", sender: "orchestrator", recipient: "receiver" } }
        yield* provideInstance(receiver)(SessionInput.Service.use((inputs) => inputs.admit(session.id, gap)))
        const unknown = yield* receipt(gap.requestID)
        expect(unknown).toMatchObject({ state: "pending", source: gap.source })
        expect(unknown.wakeObservations ?? []).toEqual([])
        expect((yield* receipt(gap.requestID)).wakeObservations ?? []).toEqual([])
        const reoffered = yield* requestInDirectory(`/session/${session.id}/input`, receiver, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(gap),
        })
        expect(reoffered.status).toBe(200)
        expect(yield* reoffered.json).toMatchObject({ requestID: gap.requestID,
          wakeObservations: [{ outcome: "coalesced", observedAt: expect.any(Number) }] })
      }),
    90_000,
  )
}
