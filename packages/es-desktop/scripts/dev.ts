import path from "node:path"
import electron from "electron"
import { createRenderer } from "./renderer"

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
const vite = await createRenderer()
await vite.listen()
const address = vite.httpServer?.address()
if (!address || typeof address === "string") throw new Error("Missing Vite address")
// Static root exists even on the first development run.
await Bun.write(path.join(root, "dist/renderer/.dev"), "")
const child = Bun.spawn([String(electron), root], {
  env: { ...process.env, ES_DESKTOP_RENDERER: `http://127.0.0.1:${address.port}`, ELECTRON_RUN_AS_NODE: undefined },
  stdout: "inherit",
  stderr: "inherit",
})
process.on("SIGINT", () => child.kill())
process.on("SIGTERM", () => child.kill())
try {
  process.exitCode = await child.exited
} finally {
  await vite.close()
}
