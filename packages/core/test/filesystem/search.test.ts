import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Schedule } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
// filesystem must load before filesystem/search: the two modules import each other.
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FileSystemSearch } from "@opencode-ai/core/filesystem/search"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep", () => {
  it.live("globs files as an array", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
        expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
      }),
    ),
  )

  it.live("greps files with include filtering", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "skip.txt"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
        expect(result).toHaveLength(1)
        expect(result[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
        expect(result[0]?.submatches[0]?.text).toBe("needle")
      }),
    ),
  )
})

const searchLayer = (directory: AbsolutePath) =>
  FileSystemSearch.ripgrepLayer.pipe(
    Layer.provide(LayerNode.compile(LayerNode.group([Ripgrep.node, FSUtil.node]))),
    Layer.provide(
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location({ directory }, { vcs: { type: "git", store: AbsolutePath.make(path.join(directory, ".git")) } }),
        ),
      ),
    ),
  )

// The index is built by a background fiber, so poll until the expected entries land.
const findUntil = (query: string, type: "file" | "directory", count: number) =>
  Effect.gen(function* () {
    const search = yield* FileSystemSearch.Service
    const entries = yield* search.find({ query, type })
    if (entries.length < count) return yield* Effect.fail("index not ready")
    return entries
  }).pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 250 }))

describe("FileSystemSearch ripgrep index", () => {
  it.live("indexes every ancestor directory of a file exactly once", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src", "nested", "deep"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "nested", "deep", "one.ts"), "a\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "nested", "deep", "two.ts"), "b\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "top.ts"), "c\n"))
        const files = yield* findUntil("ts", "file", 3)
        expect(files.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
          FileSystem.Entry.make({ path: RelativePath.make("src/nested/deep/one.ts"), type: "file" }),
          FileSystem.Entry.make({ path: RelativePath.make("src/nested/deep/two.ts"), type: "file" }),
          FileSystem.Entry.make({ path: RelativePath.make("src/top.ts"), type: "file" }),
        ])
        const directories = yield* findUntil("src", "directory", 3)
        expect(directories.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
          FileSystem.Entry.make({ path: RelativePath.make("src/"), type: "directory" }),
          FileSystem.Entry.make({ path: RelativePath.make("src/nested/"), type: "directory" }),
          FileSystem.Entry.make({ path: RelativePath.make("src/nested/deep/"), type: "directory" }),
        ])
      }).pipe(Effect.provide(searchLayer(cwd))),
    ),
  )
})
