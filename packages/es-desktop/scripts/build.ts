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
await build({
  root: path.join(root, "../es-app"),
  build: { outDir: path.join(root, "dist/renderer"), emptyOutDir: true },
})
