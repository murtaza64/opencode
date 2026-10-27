import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { serve } from "../../es-desktop/src/server"
import { createPairingCode, normalizePairingCode } from "../../es-desktop/src/pairing"

// Host-side half of the Android thin client: serves the es-app bundle and the
// es-desktop API policy to paired devices. It attaches to running services only.
export const startGateway = async (options: {
  host: string
  port: number
  code: string
  codeFile?: string
  root: string
  opencode?: string
  dashboard?: string
  opencodeAuth?: string
  publicOrigin?: string
}) =>
  serve({
    root: options.root,
    host: options.host,
    port: options.port,
    opencode: options.opencode,
    dashboard: options.dashboard,
    opencodeAuth: options.opencodeAuth,
    pairing: { code: options.code, codeFile: options.codeFile },
    publicOrigin: options.publicOrigin,
  })

// A stable code keeps devices paired across gateway restarts; delete the file to revoke them.
export const pairingCode = async (file: string) => {
  const saved = await readFile(file, "utf8").catch(() => "")
  if (normalizePairingCode(saved).length >= 16) return saved.trim()
  return storePairingCode(file, createPairingCode())
}

// The code is a credential: it lives only in an owner-only file and is never logged.
export const storePairingCode = async (file: string, code: string) => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${code}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  return code
}

if (import.meta.main) {
  const args = parseArgs({
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "47120" },
      "code-file": {
        type: "string",
        default: path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local/state"), "editspace/remote-pairing-code"),
      },
      root: { type: "string", default: path.resolve(import.meta.dir, "../dist/renderer") },
    },
  })
  const fromEnvironment = !!process.env.ES_REMOTE_PAIRING_CODE
  const code = process.env.ES_REMOTE_PAIRING_CODE || (await pairingCode(args.values["code-file"]))
  const gateway = await startGateway({
    host: args.values.host,
    port: Number(args.values.port),
    code,
    codeFile: fromEnvironment ? undefined : path.resolve(args.values["code-file"]),
    root: args.values.root,
    // serve() accepts only explicit http://127.0.0.1:PORT service origins.
    opencode: process.env.OPENCODE_URL,
    dashboard: process.env.ES_DASHBOARD_URL,
    opencodeAuth: process.env.OPENCODE_SERVER_PASSWORD
      ? `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`
      : undefined,
    // Set only when an HTTPS identity proxy (Tailscale Serve) is the sole route to this gateway.
    publicOrigin: process.env.ES_GATEWAY_PUBLIC_ORIGIN || undefined,
  })
  const port = new URL(gateway.origin).port
  console.info(`Editspace gateway ${gateway.origin}`)
  console.info(
    fromEnvironment
      ? "Pairing code: from ES_REMOTE_PAIRING_CODE"
      : `Pairing code: read it from ${args.values["code-file"]} (owner-only); delete that file to revoke paired devices`,
  )
  console.info(`USB/emulator: adb reverse tcp:${port} tcp:${port}, then connect the app to http://127.0.0.1:${port}`)
  const stop = () => void gateway.close().finally(() => process.exit(0))
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}
