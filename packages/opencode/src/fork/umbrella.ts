// fork(session-umbrella): the umbrella — an es-authored declaration that one
// directory tree is ONE semantic project. Every session whose directory sits
// anywhere under the umbrella root belongs to it, regardless of VCS root:
// the root working copy, the embedded .editspace sidecar, and lane
// workspaces all reunify even though stock opencode splits them into
// separate projects.
//
// Config is minimal by design (one root per umbrella, written once by
// `es create`, no lane-create/close hooks): membership is a pure
// directory-prefix test, and member labels are DERIVED from the
// editspace-canonical path shape under the root:
//   <root>/.editspace/lanes/<lane>/...  -> { label: <lane>, kind: lane }
//   <root>/.editspace/...               -> { label: sidecar, kind: sidecar }
//   <root>/...                          -> { label: repo root, kind: root }
//
// Mapping file: <config-dir>/umbrellas.json (or .jsonc), overridable via
// OPENCODE_UMBRELLA_CONFIG. See prds/session-umbrella.md.
import { Effect, Schema } from "effect"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { ConfigParse } from "@/config/parse"

export namespace Umbrella {
  export const Info = Schema.Struct({
    name: Schema.String,
    root: Schema.String,
  }).annotate({ identifier: "Umbrella" })
  export type Info = typeof Info.Type

  export const Member = Schema.Struct({
    directory: Schema.String,
    label: Schema.String,
    kind: Schema.Literals(["root", "sidecar", "lane"]),
  }).annotate({ identifier: "UmbrellaMember" })
  export type Member = typeof Member.Type

  const File = Schema.Struct({
    umbrellas: Schema.Array(Info),
  })

  const normalize = (dir: string) => (dir.length > 1 ? dir.replace(/\/+$/, "") : dir)

  /** true when `dir` is at or under `parent` */
  const contains = (parent: string, dir: string) => {
    const p = normalize(parent)
    const d = normalize(dir)
    return d === p || d.startsWith(p + "/")
  }

  export const configPath = () =>
    Flag.OPENCODE_UMBRELLA_CONFIG ?? path.join(Global.Path.config, "umbrellas.json")

  /** Load the mapping. Missing/broken file degrades to "no umbrellas". */
  export const load = Effect.fn("Umbrella.load")(function* () {
    const file = configPath()
    const text = yield* Effect.tryPromise(() => readFile(file, "utf8")).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (!text) return [] as Info[]
    return yield* Effect.sync((): Info[] => {
      const data = ConfigParse.jsonc(text, file)
      return [...ConfigParse.schema(File, data, file).umbrellas]
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to parse umbrella config", { path: file, cause }).pipe(
          Effect.as([] as Info[]),
        ),
      ),
    )
  })

  /** The umbrella (if any) that a directory belongs to. */
  export const find = (umbrellas: readonly Info[], directory: string) =>
    umbrellas.find((umbrella) => contains(umbrella.root, directory))

  const SIDECAR = ".editspace"

  /**
   * Derive the member a directory belongs to from the editspace-canonical
   * layout under the umbrella root. Returns undefined when the directory is
   * outside the umbrella.
   */
  export const memberFor = (umbrella: Info, directory: string): Member | undefined => {
    const root = normalize(umbrella.root)
    if (!contains(root, directory)) return undefined
    const relative = normalize(directory).slice(root.length).replace(/^\//, "")
    const segments = relative === "" ? [] : relative.split("/")
    if (segments[0] !== SIDECAR) {
      return { directory: root, label: "repo root", kind: "root" }
    }
    if (segments[1] === "lanes" && segments[2]) {
      return {
        directory: [root, SIDECAR, "lanes", segments[2]].join("/"),
        label: segments[2],
        kind: "lane",
      }
    }
    return { directory: [root, SIDECAR].join("/"), label: "sidecar", kind: "sidecar" }
  }
}
