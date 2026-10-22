import path from "node:path"
import { build } from "vite"

// The gateway serves the same es-app bundle the desktop shell embeds.
const root = path.resolve(import.meta.dir, "..")
await build({
  root: path.join(root, "../es-app"),
  build: { outDir: path.join(root, "dist/renderer"), emptyOutDir: true },
})
