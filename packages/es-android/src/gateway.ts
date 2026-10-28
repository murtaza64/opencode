import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { serve } from "../../es-desktop/src/server"
import { createPairingCode, normalizePairingCode } from "../../es-desktop/src/pairing"
import { hostIdentity, localHost } from "../../es-app/remote-host"

// Host-side half of the Android thin client: serves the es-app bundle and the
// es-desktop API policy to paired devices. It attaches to running services only.
export const startGateway = async (options: {
  host: string
  port: number
  code: string | (() => string)
  codeFile?: string
  root: string
  opencode?: string
  dashboard?: string
  opencodeAuth?: string
  publicOrigin?: string
  // This host's own identity (ES_HOST_ID/LABEL/PROFILE/KIND), reported to paired devices at /__es/host.
  identity?: ReturnType<typeof hostIdentity>
}) =>
  serve({
    ...(options.identity ? { hostInfo: () => ({ ...localHost, ...options.identity! }) } : {}),
    root: options.root,
    host: options.host,
    port: options.port,
    opencode: options.opencode,
    dashboard: options.dashboard,
    opencodeAuth: options.opencodeAuth,
    pairing: { code: options.code, codeFile: options.codeFile, sshHost: process.env.ES_GATEWAY_PAIRING_SSH || undefined },
    publicOrigin: options.publicOrigin,
  })

// A stable code keeps devices paired across gateway restarts; delete the file to revoke them.
export const pairingCode = async (file: string) => {
  const saved = await readFile(file, "utf8").catch(() => "")
  if (normalizePairingCode(saved).length >= 16) return saved.trim()
  return storePairingCode(file, createPairingCode())
}

// The code is a credential: it lives only in an owner-only file and is never logged. Written to a
// temporary file and renamed, so a reader never sees a partial code.
export const storePairingCode = async (file: string, code: string) => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(`${file}.tmp`, `${code}\n`, { mode: 0o600 })
  await chmod(`${file}.tmp`, 0o600)
  await rename(`${file}.tmp`, file)
  return code
}

/** The code in `file`, re-read when the file changes (checked at most once a second), so writing a new
 * code (Pair a Phone > Rotate) revokes paired devices without a restart. A deleted file gets a new
 * code, as deleting it always revoked devices. An unreadable or short file keeps the last code. */
export const watchedPairingCode = (file: string, initial: string, now = Date.now) => {
  const last = { code: initial, mtime: statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0, checked: now() }
  return () => {
    if (now() - last.checked < 1000) return last.code
    last.checked = now()
    const stat = statSync(file, { throwIfNoEntry: false })
    if (!stat) {
      const code = createPairingCode()
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(`${file}.tmp`, `${code}\n`, { mode: 0o600 })
      chmodSync(`${file}.tmp`, 0o600)
      renameSync(`${file}.tmp`, file)
      last.code = code
      last.mtime = statSync(file).mtimeMs
      return code
    }
    if (stat.mtimeMs === last.mtime) return last.code
    last.mtime = stat.mtimeMs
    const text = readFileSync(file, "utf8")
    if (normalizePairingCode(text).length >= 16) last.code = text.trim()
    return last.code
  }
}

/** Where the desktop app's Pair a Phone reads this gateway's phone-facing origin: beside the code file. */
export const gatewayDescriptor = (codeFile: string) => path.join(path.dirname(codeFile), "gateway.json")

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
  const codeFile = path.resolve(args.values["code-file"])
  const gateway = await startGateway({
    host: args.values.host,
    port: Number(args.values.port),
    code: fromEnvironment ? code : watchedPairingCode(codeFile, code),
    codeFile: fromEnvironment ? undefined : codeFile,
    root: args.values.root,
    // serve() accepts only explicit http://127.0.0.1:PORT service origins.
    opencode: process.env.OPENCODE_URL,
    dashboard: process.env.ES_DASHBOARD_URL,
    opencodeAuth: process.env.OPENCODE_SERVER_PASSWORD
      ? `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`
      : undefined,
    // Set only when an HTTPS identity proxy (Tailscale Serve) is the sole route to this gateway.
    publicOrigin: process.env.ES_GATEWAY_PUBLIC_ORIGIN || undefined,
    // Desk keys reach, pins and glyphs by this verified id; an invalid setting stops the gateway.
    identity: hostIdentity(process.env.ES_HOST_ID ? { id: process.env.ES_HOST_ID, label: process.env.ES_HOST_LABEL, profile: process.env.ES_HOST_PROFILE || undefined, kind: process.env.ES_HOST_KIND || undefined } : undefined),
  })
  const port = new URL(gateway.origin).port
  // The phone-facing origin for Pair a Phone (owner-only, no secret): the public origin when an HTTPS
  // proxy fronts this gateway, else its own loopback origin (adb reverse).
  if (!fromEnvironment)
    await writeFile(gatewayDescriptor(codeFile), `${JSON.stringify({ v: 1, origin: process.env.ES_GATEWAY_PUBLIC_ORIGIN || gateway.origin })}\n`, { mode: 0o600 })
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
