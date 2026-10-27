import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { PaletteContext } from "@opencode-ai/core/palette-context"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { testEffect } from "./lib/effect"

const home = "/home/test"
const path = PaletteContext.contractPath(home)
const contract = (scheme: string, revision: string) =>
  JSON.stringify({ schema: "wal-palette/1", revision, scheme, roles: { bg: "#000001" }, highlights: [] })

// A mutable stand-in for the palette.json the pywal fork writes on each palette change.
const files = new Map<string, string>()
const paletteFS = Layer.effect(
  FSUtil.Service,
  FSUtil.Service.pipe(
    Effect.map((fs) => FSUtil.Service.of({ ...fs, readFileStringSafe: (file) => Effect.sync(() => files.get(file)) })),
  ),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SystemContextRegistry.node, PaletteContext.node]), [
    [Global.node, Global.layerWith({ home })],
    [FSUtil.node, paletteFS],
  ]),
)

const load = SystemContextRegistry.Service.pipe(Effect.flatMap((registry) => registry.load()))

describe("PaletteContext", () => {
  it.effect("adds no context on hosts without a palette contract", () =>
    Effect.gen(function* () {
      files.clear()
      expect((yield* SystemContext.initialize(yield* load)).baseline).toBe("")
    }),
  )

  it.effect("names roles and scheme without colour values", () =>
    Effect.gen(function* () {
      files.set(path, contract("dark", "aaaaaaaaaaaa"))
      const baseline = (yield* SystemContext.initialize(yield* load)).baseline
      expect(baseline).toContain("wal-palette/1, dark scheme")
      expect(baseline).toContain("--wal-accent")
      expect(baseline).toContain(PaletteContext.LIVE_SCRIPT)
      expect(baseline).not.toContain("wal-palette inject")
      expect(baseline).not.toContain("#000001")
    }),
  )

  it.effect("stays unchanged when only the colours change", () =>
    Effect.gen(function* () {
      files.set(path, contract("dark", "aaaaaaaaaaaa"))
      const initialized = yield* SystemContext.initialize(yield* load)
      files.set(path, contract("dark", "bbbbbbbbbbbb"))
      expect(yield* SystemContext.reconcile(yield* load, initialized.snapshot)).toEqual({ _tag: "Unchanged" })
    }),
  )

  it.effect("updates when the scheme flips between dark and light", () =>
    Effect.gen(function* () {
      files.set(path, contract("dark", "aaaaaaaaaaaa"))
      const initialized = yield* SystemContext.initialize(yield* load)
      files.set(path, contract("light", "cccccccccccc"))
      expect(yield* SystemContext.reconcile(yield* load, initialized.snapshot)).toMatchObject({
        _tag: "Updated",
        text: expect.stringContaining("light scheme"),
      })
    }),
  )
})
