/* Read-only acceptance evidence for the Personal activation (DD #495/#531): add a bridged `excalibur` host entry beside
 * the page host. `pre` records what the activation must not disturb; `post` records what it should have produced and
 * compares Work against `pre`. Output is JSON only. Nothing here writes, pairs, prompts, or reads a secret or cookie
 * value: Keychain items are checked by `security` exit code with output discarded, and the listener key that guards
 * /__es/host stays inside the app (so that route is probed for reachability only). */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { connect } from "node:net"
import path from "node:path"
import { remoteHosts } from "../../es-app/remote-host"
import { legacyPaletteDigest, legacyPaletteOf } from "./appearance"

export const CHECK_SCHEMA = "es-personal-activation-check/1"
const KEYCHAIN_ACCOUNTS = ["client-id", "client-secret"]

export type Paths = { userData: string; cache: string }
/** `keychain`: Keychain item names to check besides those the config names (before activation the config names none). */
export type Options = Paths & { host: string; transfer: string; keychain?: string[]; keychainExit?: (item: string, account: string) => Promise<number> }

export const preCheck = async (options: Options) => {
  const origins = await serviceOrigins(options.userData)
  const items = [...new Set([...(origins.present ? origins.hosts ?? [] : []).flatMap((host) => host.access ? [host.access.keychain] : []), ...(options.keychain ?? [])])]
  const exit = options.keychainExit ?? keychainExit
  return {
    schema: CHECK_SCHEMA,
    phase: "pre" as const,
    at: new Date().toISOString(),
    serviceOrigins: origins,
    keychain: await Promise.all(items.flatMap((item) => KEYCHAIN_ACCOUNTS.map(async (account) => {
      const code = await exit(item, account)
      return { item, account, present: code === 0, exitCode: code }
    }))),
    profileCache: await profileCache(options.cache, options.transfer),
    work: await receipt(path.join(options.userData, "appearance-receipt.json")),
  }
}

export const postCheck = async (options: Options & { pre?: Awaited<ReturnType<typeof preCheck>> }) => {
  const personal = await receipt(path.join(options.userData, "appearance-receipt-personal.json"))
  const work = await receipt(path.join(options.userData, "appearance-receipt.json"))
  const applied = personal.present ? personal.applied.filter((item) => item.host === options.host) : []
  const consumed = personal.present ? personal.consumed : undefined
  const before = options.pre?.work
  return {
    schema: CHECK_SCHEMA,
    phase: "post" as const,
    at: new Date().toISOString(),
    serviceOrigins: await serviceOrigins(options.userData),
    listener: await listener(options.userData, options.host),
    personal: { present: personal.present, consumed, applied, wallpaper: personal.present ? personal.wallpaper : undefined },
    work,
    checks: {
      consumedTransfer: !!consumed && transferIs(consumed.transfer, options.transfer),
      appliedOnHost: applied.some((item) => item.theme === "wallpaper" && item.walRevision !== null),
      // Work identity unchanged by the activation: the same palette revision and colours as before it.
      // null: no pre, or no Work receipt before and after (nothing to compare, not a regression).
      workUnchanged: before === undefined || (!before.present && !work.present) ? null
        : before.present && work.present && before.walRevision === work.walRevision && before.background === work.background && before.foreground === work.foreground,
    },
  }
}

/** service-origins.json: its bytes' sha256, the parsed hosts, and the page host entry re-serialised as canonical JSON with its
 * sha256 (comparable pre vs post; not the file's literal bytes). Config only, no secret. */
const serviceOrigins = async (userData: string) => {
  const file = path.join(userData, "service-origins.json")
  const bytes = await readFile(file).catch(() => undefined)
  if (!bytes) return { path: file, present: false as const }
  const raw = parse(bytes.toString("utf8"))
  const entries = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).hosts) ? (raw as { hosts: unknown[] }).hosts : []
  const hosts = (() => { try { return remoteHosts(entries.length ? entries : undefined) } catch { return undefined } })()
  const page = entries.find((item) => !!item && typeof item === "object" && (item as Record<string, unknown>).mode === "page")
  const pageBytes = page === undefined ? undefined : Buffer.from(JSON.stringify(page))
  return {
    path: file,
    present: true as const,
    sha256: sha256(bytes),
    bytes: bytes.length,
    valid: hosts !== undefined,
    hosts,
    pageEntry: pageBytes && { json: pageBytes.toString("utf8"), bytes: pageBytes.length, sha256: sha256(pageBytes) },
  }
}

/** The profile cache's descriptor and whether its asset's bytes hash to the recorded sha256. */
const profileCache = async (cache: string, transfer: string) => {
  const file = path.join(cache, "descriptor.json")
  const descriptor = parse(await readFile(file, "utf8").catch(() => ""))
  if (!descriptor || typeof descriptor !== "object") return { path: file, present: false as const }
  const record = descriptor as Record<string, unknown>
  const asset = (record.asset && typeof record.asset === "object" ? record.asset : {}) as Record<string, unknown>
  const assetFile = typeof asset.file === "string" && /^assets\/[0-9a-f]{64}\.(jpe?g|png|webp)$/.test(asset.file) ? path.join(cache, asset.file) : undefined
  const info = assetFile ? await lstat(assetFile).catch(() => undefined) : undefined
  const bytes = info?.isFile() ? await readFile(assetFile!).catch(() => undefined) : undefined
  const legacy = legacyPaletteOf(record.palette && typeof record.palette === "object" ? record.palette as Record<string, unknown> : {})
  return {
    path: file,
    present: true as const,
    schema: record.schema,
    profile: record.profile,
    producer: record.producer,
    transfer: record.transfer,
    transferMatches: typeof record.transfer === "string" && transferIs(record.transfer, transfer),
    asset: { sha256: asset.sha256, file: asset.file, type: asset.type, bytes: asset.bytes },
    assetVerified: !!bytes && sha256(bytes) === asset.sha256,
    paletteDigest: legacy ? legacyPaletteDigest(legacy) : undefined,
  }
}

type Applied = { host: string; walRevision: string | null; theme: string; appliedAt: number }

/** An appearance receipt's recorded fields (es-appearance-receipt/1). */
const receipt = async (file: string) => {
  const raw = parse(await readFile(file, "utf8").catch(() => ""))
  if (!raw || typeof raw !== "object") return { path: file, present: false as const }
  const record = raw as Record<string, unknown>
  const consumed = record.consumed && typeof record.consumed === "object" ? record.consumed as Record<string, unknown> : undefined
  return {
    path: file,
    present: true as const,
    schema: record.schema,
    walRevision: typeof record.walRevision === "string" ? record.walRevision : undefined,
    background: record.background,
    foreground: record.foreground,
    wallpaper: typeof record.wallpaper === "string" ? record.wallpaper : undefined,
    updatedAt: record.updatedAt,
    consumed: consumed && typeof consumed.transfer === "string" && typeof consumed.sha256 === "string" && typeof consumed.paletteDigest === "string"
      ? { transfer: consumed.transfer, sha256: consumed.sha256, paletteDigest: consumed.paletteDigest } : undefined,
    applied: (Array.isArray(record.applied) ? record.applied : []).flatMap((item): Applied[] =>
      item && typeof item === "object" && typeof (item as Applied).host === "string" ? [{
        host: (item as Applied).host, walRevision: (item as Applied).walRevision ?? null, theme: String((item as Applied).theme), appliedAt: Number((item as Applied).appliedAt),
      }] : []),
  }
}

/** The host's listener: its saved port and whether it accepts a connection. /__es/host needs the in-app listener key, so it is
 * not read; the `applied` entry for this host (written by that listener's own page) is the identity evidence. */
const listener = async (userData: string, host: string) => {
  const port = Number(await readFile(path.join(userData, `loopback-port-${host}`), "utf8").catch(() => "0"))
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { port: undefined, reachable: false }
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 2_000 }, () => { socket.destroy(); resolve(true) })
    socket.on("error", () => resolve(false))
    socket.on("timeout", () => { socket.destroy(); resolve(false) })
  })
  return { port, reachable, hostRoute: "not read: needs the in-app listener key" }
}

const keychainExit = (item: string, account: string) => new Promise<number>((resolve) => {
  // Without -w or -g no secret is printed, and all output is discarded.
  const child = spawn("security", ["find-generic-password", "-s", item, "-a", account], { stdio: "ignore", timeout: 10_000 })
  child.on("error", () => resolve(-1))
  child.on("exit", (code) => resolve(code ?? -1))
})

// A transfer is named `<kind>:<id>`; the check takes the id or a prefix of it (e.g. 64b951fe).
const transferIs = (transfer: string, expected: string) => transfer.startsWith(expected) || (transfer.split(":").at(-1) ?? "").startsWith(expected)
const parse = (text: string): unknown => { try { return JSON.parse(text) } catch { return undefined } }
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
