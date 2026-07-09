// fork(session-umbrella): HTTP API seam tests for the umbrella listing.
import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Workspace.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

type UmbrellaSessionJson = {
  id: string
  directory: string
  title: string
  umbrella: string
  member: { directory: string; label: string; kind: "root" | "sidecar" | "lane" | "mirror" }
}

const listFor = (directory: string) =>
  request("/umbrella/session", { headers: { "x-opencode-directory": directory } }).pipe(
    Effect.flatMap(json<UmbrellaSessionJson[]>),
  )

const writeMapping = (configDir: string, umbrellas: { name: string; root: string }[]) =>
  Effect.gen(function* () {
    const mappingFile = path.join(configDir, "umbrellas.json")
    yield* Effect.promise(() => writeFile(mappingFile, JSON.stringify({ umbrellas })))
    process.env["OPENCODE_UMBRELLA_CONFIG"] = mappingFile
  })

afterEach(async () => {
  delete process.env["OPENCODE_UMBRELLA_CONFIG"]
  await disposeAllInstances()
  await resetDatabase()
})

describe("umbrella HttpApi", () => {
  it.live("reunifies root, sidecar, and lane sessions with derived labels", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const otherDir = yield* tmpdirScoped({ git: true })
      const configDir = yield* tmpdirScoped()
      yield* writeMapping(configDir, [{ name: "demo", root }])

      // editspace-canonical layout: sidecar + lane are separate git roots on
      // purpose — stock opencode splits them into different projects.
      const sidecarDir = path.join(root, ".editspace")
      const laneDir = path.join(root, ".editspace", "lanes", "alpha", "repos", "me", "demo")
      yield* Effect.promise(() => mkdir(laneDir, { recursive: true }))

      const rootSession = yield* Session.use.create({ title: "root session" }).pipe(provideInstanceEffect(root))
      const sidecarSession = yield* Session.use
        .create({ title: "sidecar session" })
        .pipe(provideInstanceEffect(sidecarDir))
      const laneSession = yield* Session.use.create({ title: "lane session" }).pipe(provideInstanceEffect(laneDir))
      yield* Session.use.create({ title: "outside session" }).pipe(provideInstanceEffect(otherDir))

      // ONE view of the semantic project from every corner of it
      for (const requester of [root, sidecarDir, laneDir]) {
        const sessions = yield* listFor(requester)
        expect(sessions.map((session) => session.id).toSorted()).toEqual(
          [rootSession.id, sidecarSession.id, laneSession.id].toSorted(),
        )
        expect(sessions.every((session) => session.umbrella === "demo")).toBe(true)
      }

      const sessions = yield* listFor(root)
      const byID = new Map(sessions.map((session) => [session.id, session]))
      expect(byID.get(rootSession.id)?.member).toEqual({ directory: root, label: "repo root", kind: "root" })
      expect(byID.get(sidecarSession.id)?.member).toEqual({
        directory: sidecarDir,
        label: "sidecar",
        kind: "sidecar",
      })
      expect(byID.get(laneSession.id)?.member).toEqual({
        directory: path.join(root, ".editspace", "lanes", "alpha"),
        label: "alpha",
        kind: "lane",
      })

      // non-member directory: stock behavior, empty result
      expect(yield* listFor(otherDir)).toHaveLength(0)
    }),
  )

  it.live("reunifies multi-repo editspace lanes, mirror, and umbrella-root sessions", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const configDir = yield* tmpdirScoped()
      yield* writeMapping(configDir, [{ name: "es", root }])

      // multi-repo editspace canonical layout (no .editspace segment) —
      // shape verified against the live api-testing editspace in the
      // dotfiles#42 landing check (2026-07-09): tracker at the root repo,
      // read-only mirrors at repos/<owner>/<repo>, lane workspaces at
      // lanes/<lane>/repos/<owner>/<repo>.
      const laneDir = path.join(root, "lanes", "esd-rollout", "repos", "duolingo", "goals-backend")
      const mirrorDir = path.join(root, "repos", "duolingo", "goals-backend")
      yield* Effect.promise(() => mkdir(laneDir, { recursive: true }))
      yield* Effect.promise(() => mkdir(mirrorDir, { recursive: true }))

      const rootSession = yield* Session.use.create({ title: "tracker session" }).pipe(provideInstanceEffect(root))
      const laneSession = yield* Session.use.create({ title: "lane session" }).pipe(provideInstanceEffect(laneDir))
      const mirrorSession = yield* Session.use
        .create({ title: "mirror session" })
        .pipe(provideInstanceEffect(mirrorDir))

      for (const requester of [root, laneDir, mirrorDir]) {
        const sessions = yield* listFor(requester)
        expect(sessions.map((session) => session.id).toSorted()).toEqual(
          [rootSession.id, laneSession.id, mirrorSession.id].toSorted(),
        )
      }

      const sessions = yield* listFor(root)
      const byID = new Map(sessions.map((session) => [session.id, session]))
      expect(byID.get(rootSession.id)?.member).toEqual({ directory: root, label: "repo root", kind: "root" })
      expect(byID.get(laneSession.id)?.member).toEqual({
        directory: path.join(root, "lanes", "esd-rollout"),
        label: "esd-rollout",
        kind: "lane",
      })
      expect(byID.get(mirrorSession.id)?.member).toEqual({
        directory: path.join(root, "repos"),
        label: "mirror",
        kind: "mirror",
      })
    }),
  )

  it.live(".editspace patterns win over bare lanes/ when both shapes coexist", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const configDir = yield* tmpdirScoped()
      yield* writeMapping(configDir, [{ name: "demo", root }])

      // single-repo sidecars live under a repo root, and that repo may also
      // contain directories literally named lanes/ or repos/ — the sidecar
      // dialect must take precedence for its own subtree.
      const sidecarLaneDir = path.join(root, ".editspace", "lanes", "alpha", "repos", "me", "demo")
      const bareLaneDir = path.join(root, "lanes", "beta", "repos", "me", "demo")
      yield* Effect.promise(() => mkdir(sidecarLaneDir, { recursive: true }))
      yield* Effect.promise(() => mkdir(bareLaneDir, { recursive: true }))

      const sidecarLaneSession = yield* Session.use
        .create({ title: "sidecar lane" })
        .pipe(provideInstanceEffect(sidecarLaneDir))
      const bareLaneSession = yield* Session.use
        .create({ title: "bare lane" })
        .pipe(provideInstanceEffect(bareLaneDir))

      const sessions = yield* listFor(root)
      const byID = new Map(sessions.map((session) => [session.id, session]))
      expect(byID.get(sidecarLaneSession.id)?.member).toEqual({
        directory: path.join(root, ".editspace", "lanes", "alpha"),
        label: "alpha",
        kind: "lane",
      })
      expect(byID.get(bareLaneSession.id)?.member).toEqual({
        directory: path.join(root, "lanes", "beta"),
        label: "beta",
        kind: "lane",
      })
    }),
  )

  it.live("returns empty without a mapping file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      process.env["OPENCODE_UMBRELLA_CONFIG"] = path.join(dir, "missing.json")
      yield* Session.use.create({ title: "any" }).pipe(provideInstanceEffect(dir))
      expect(yield* listFor(dir)).toHaveLength(0)
    }),
  )

  it.live("prefix match does not cross sibling directories with shared name prefixes", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const configDir = yield* tmpdirScoped()
      // sibling dir sharing the string prefix but not the path boundary
      const sibling = root + "-sibling"
      yield* Effect.promise(() => mkdir(sibling))
      yield* writeMapping(configDir, [{ name: "demo", root }])

      const inside = yield* Session.use.create({ title: "inside" }).pipe(provideInstanceEffect(root))
      yield* Session.use.create({ title: "sibling" }).pipe(provideInstanceEffect(sibling))

      const sessions = yield* listFor(root)
      expect(sessions.map((session) => session.id)).toEqual([inside.id])
      expect(yield* listFor(sibling)).toHaveLength(0)
    }),
  )
})
