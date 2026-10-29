import { rm } from "node:fs/promises"
import path from "node:path"
import { build } from "vite"

const root = path.resolve(import.meta.dir, "..")
const output = await Bun.build({
  entrypoints: [path.join(root, "src/main.ts")],
  outdir: path.join(root, "dist"),
  target: "node",
  format: "cjs",
  naming: "main.cjs",
  external: ["electron"],
})
if (!output.success) throw new AggregateError(output.logs, "Electron main build failed")
// This release's notes, and which release this build is (the publisher's ES_RELEASE: the exact landed rev). Without
// ES_RELEASE the build names no release and the app shows no notes.
// An earlier build's files never carry over.
await Promise.all(["release-notes.json", "build-info.json"].map((name) => rm(path.join(root, "dist", name), { force: true })))
const notes = Bun.file(path.join(root, "release-notes.json"))
if (await notes.exists()) await Bun.write(path.join(root, "dist/release-notes.json"), notes)
if (process.env.ES_RELEASE) await Bun.write(path.join(root, "dist/build-info.json"), JSON.stringify({ release: process.env.ES_RELEASE }))
await build({
  root: path.join(root, "../es-app"),
  build: { outDir: path.join(root, "dist/renderer"), emptyOutDir: true },
})
