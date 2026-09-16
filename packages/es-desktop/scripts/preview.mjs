import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import electron from "electron"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

const fixture = await createFixture()
const profile = await mkdtemp(path.join(tmpdir(), "editspace-preview-"))
const root = fileURLToPath(new URL("..", import.meta.url))
const executable = process.env.ES_DESKTOP_EXECUTABLE ?? electron
const child = spawn(executable, process.env.ES_DESKTOP_EXECUTABLE ? [] : [root], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    OPENCODE_SERVER_PASSWORD: "",
    OPENCODE_URL: fixture.url,
    ES_DASHBOARD_URL: fixture.url,
    ES_DESKTOP_USER_DATA: profile,
    ES_DESKTOP_RENDERER: "",
  },
  stdio: "inherit",
})
console.info(`Fixture-only preview PID ${process.pid}; Electron PID ${child.pid}; fixture ${fixture.url}`)
console.info("No model provider, backend process, or production service is used. Close the window to stop.")
process.on("SIGINT", () => child.kill())
process.on("SIGTERM", () => child.kill())
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("exit", (code) => resolve(code ?? 0))
  })
} finally {
  await fixture.close()
  await rm(profile, { recursive: true, force: true })
}
