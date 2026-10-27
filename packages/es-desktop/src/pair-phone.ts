/* Pair a Phone: a host gateway's phone-facing origin and pairing code, shown in a desktop window as
 * text and as a QR the Desk app scans. The code is a credential: it is read from the host's
 * owner-only code file (this machine's, or another host's over the owner's SSH), held only in this
 * window, and never logged, printed or put in a URL other than the QR payload. */
import { spawn } from "node:child_process"
import { readFile, rename, writeFile, chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { renderSVG } from "uqr"
import { createPairingCode, normalizePairingCode } from "./pairing"

export type Pairing = { origin: string; code: string }
export type PairingSource = { kind: "local"; dir: string } | { kind: "ssh"; destination: string }

const ALPHABET = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{20}$/

/** The Desk app's QR payload (agreed with android-lead): v=1, exact origin, canonical code. */
export const pairingURI = (pairing: Pairing) =>
  `opencode-desk://pair?v=1&url=${encodeURIComponent(pairing.origin)}&code=${pairing.code}`

/** A code in its canonical XXXXX-XXXXX-XXXXX-XXXXX form, or undefined when it is not a generated code
 * (e.g. set by ES_REMOTE_PAIRING_CODE); such a code is shown as text without a QR. */
export const canonicalCode = (value: string) => {
  const code = normalizePairingCode(value)
  return ALPHABET.test(code) ? code.match(/.{5}/g)!.join("-") : undefined
}

/** A phone-facing origin: https with no path, or http on loopback (adb reverse). */
export const phoneOrigin = (value: unknown) => {
  const url = typeof value === "string" ? URL.parse(value) : null
  if (!url || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined
  if (url.protocol === "https:") return url.origin
  if (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) return url.origin
  return undefined
}

/** An SSH destination from config: a host alias or user@host, never an option. */
export const sshDestination = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]*(@[A-Za-z0-9_][A-Za-z0-9_.-]*)?$/.test(value) && value.length <= 128 ? value : undefined

/** Per-host pairing sources from service-origins.json "pairing": { "<host id>": { "ssh": "<destination>" } }. */
export const pairingSources = (saved: unknown) => {
  const pairing = saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, unknown>).pairing : undefined
  if (!pairing || typeof pairing !== "object" || Array.isArray(pairing)) return new Map<string, PairingSource>()
  return new Map(Object.entries(pairing).flatMap(([id, item]) => {
    const destination = sshDestination(item && typeof item === "object" ? (item as Record<string, unknown>).ssh : undefined)
    return destination && id !== "local" ? [[id, { kind: "ssh", destination } as PairingSource]] : []
  }))
}

/** This machine's gateway state directory (the gateway's default code file lives here). */
export const localStateDir = (env: { XDG_STATE_HOME?: string }, home: string) =>
  path.join(env.XDG_STATE_HOME || path.join(home, ".local/state"), "editspace")

// Runs on the remote host's POSIX shell; the code travels only on stdout/stdin of the SSH channel.
const REMOTE_DIR = `d="\${XDG_STATE_HOME:-$HOME/.local/state}/editspace"`
const REMOTE_READ = `${REMOTE_DIR}; cat -- "$d/remote-pairing-code" && printf '\\n' && cat -- "$d/gateway.json"`
const REMOTE_WRITE = `${REMOTE_DIR}; umask 077; cat > "$d/remote-pairing-code.tmp" && mv -f -- "$d/remote-pairing-code.tmp" "$d/remote-pairing-code"`

export type Run = (destination: string, script: string, input?: string) => Promise<string>

/** One command on the host over the owner's SSH (keys/agent only, no prompts). Output is never logged. */
export const ssh: Run = (destination, script, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", destination, script], { stdio: ["pipe", "pipe", "ignore"] })
    const out: Buffer[] = []
    const timer = setTimeout(() => child.kill(), 20_000)
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
    child.on("error", () => reject(new Error("SSH is not available")))
    child.on("close", (status) => {
      clearTimeout(timer)
      if (status === 0) resolve(Buffer.concat(out).toString("utf8"))
      else reject(new Error(`Could not reach ${destination} over SSH`))
    })
    child.stdin.end(input ?? "")
  })

/** The host gateway's origin and code, or an error message fit to show. */
export const readPairing = async (source: PairingSource, run: Run = ssh): Promise<Pairing | { error: string }> => {
  const text = source.kind === "local"
    ? await Promise.all([readFile(path.join(source.dir, "remote-pairing-code"), "utf8"), readFile(path.join(source.dir, "gateway.json"), "utf8")])
      .then(([code, descriptor]) => `${code.trim()}\n${descriptor}`, () => undefined)
    : await run(source.destination, REMOTE_READ).catch(() => undefined)
  if (text === undefined) return { error: source.kind === "local" ? "No phone gateway runs on this Mac (no pairing code or gateway.json)." : `Could not read the gateway on ${source.destination} over SSH.` }
  const [first, ...rest] = text.split("\n")
  const code = normalizePairingCode(first ?? "").length >= 16 ? (first ?? "").trim() : undefined
  const origin = phoneOrigin(parseOrigin(rest.join("\n")))
  if (!code) return { error: "The gateway has no usable pairing code." }
  if (!origin) return { error: "The gateway has not recorded a phone-facing https origin. Restart it on a current version." }
  return { origin, code }
}

/** Writes a new code on the host; its gateway picks it up within a second and every paired device must pair again. */
export const rotatePairing = async (source: PairingSource, run: Run = ssh) => {
  const code = createPairingCode()
  if (source.kind === "ssh") {
    await run(source.destination, REMOTE_WRITE, `${code}\n`)
    return
  }
  const file = path.join(source.dir, "remote-pairing-code")
  await mkdir(source.dir, { recursive: true, mode: 0o700 })
  await writeFile(`${file}.tmp`, `${code}\n`, { mode: 0o600 })
  await chmod(`${file}.tmp`, 0o600)
  await rename(`${file}.tmp`, file)
}

const parseOrigin = (text: string) => {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === "object" ? (value as Record<string, unknown>).origin : undefined
  } catch {
    return undefined
  }
}

/** What the pairing window shows. The QR exists only for a canonical code. */
export const pairingView = (label: string, pairing: Pairing | { error: string }) => {
  if ("error" in pairing) return { label, error: pairing.error }
  const code = canonicalCode(pairing.code)
  return { label, origin: pairing.origin, code: code ?? pairing.code, qr: code ? renderSVG(pairingURI({ origin: pairing.origin, code }), { border: 2 }) : undefined }
}

export type PairingView = ReturnType<typeof pairingView>

// Static window page: it holds no secret; the view arrives later through render(). Actions leave the
// page only as es-pair: navigations, which the main process intercepts.
export const pairingWindowPage = `<!doctype html>
<html lang="en" dir="ltr">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="color-scheme" content="dark light">
<title>Pair a Phone</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:20px 24px;background:Canvas;color:CanvasText}
h1{font-size:17px;font-weight:600;margin:0 0 4px}p{margin:0 0 12px;opacity:.75}
dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 12px;margin:16px 0}dt{opacity:.7}dd{margin:0;overflow-wrap:anywhere;font-family:ui-monospace,monospace}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-block:12px}button{font:inherit;padding:6px 12px;border-radius:6px}
#qr{display:grid;place-items:center;margin-block:16px}#qr svg{inline-size:220px;block-size:220px;background:#fff;padding:8px;border-radius:8px}
.error{color:#d9534f}[hidden]{display:none!important}
</style>
<main>
<h1 id="title">Pair a Phone</h1>
<p>Scan with Desk on the phone (Connect), or type the address and code. Anyone with the code can pair.</p>
<p id="error" class="error" role="alert" hidden></p>
<section id="details" hidden>
<dl><dt>Address</dt><dd id="origin" dir="ltr"></dd><dt>Code</dt><dd id="code" dir="ltr" aria-live="polite">•••••-•••••-•••••-•••••</dd></dl>
<div class="row"><button id="reveal" type="button">Reveal</button><button id="copy" type="button">Copy code</button><button id="rotate" type="button">Rotate code…</button></div>
<div id="qr" hidden></div>
<p id="noqr" hidden>This code was set by hand, so there is no QR. Type it on the phone.</p>
</section>
</main>
<script>
const $ = (id) => document.getElementById(id)
const state = { view: undefined, shown: false }
const act = (name) => { location.href = "es-pair:" + name }
const draw = () => {
  const view = state.view
  if (!view) return
  $("title").textContent = "Pair a Phone with " + view.label
  $("error").hidden = !view.error
  $("error").textContent = view.error || ""
  $("details").hidden = !!view.error
  if (view.error) return
  $("origin").textContent = view.origin
  $("code").textContent = state.shown ? view.code : "•••••-•••••-•••••-•••••"
  $("reveal").textContent = state.shown ? "Hide" : "Reveal"
  $("qr").hidden = !state.shown || !view.qr
  $("qr").innerHTML = state.shown && view.qr ? view.qr : ""
  $("noqr").hidden = !state.shown || !!view.qr
}
window.render = (view) => { state.view = view; state.shown = false; draw() }
$("reveal").onclick = () => { state.shown = !state.shown; draw() }
$("copy").onclick = () => act("copy")
$("rotate").onclick = () => act("rotate")
</script>
</html>`
