import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto"
import { isIP } from "node:net"
import type { IncomingHttpHeaders } from "node:http"

// Remote clients (the Android shell) reach the keyed es-app listener without the
// native x-editspace-key capability. They prove possession of a pairing code once
// and then carry an HttpOnly cookie signed with that code: rotating the code
// revokes every paired device, and a stable code survives gateway restarts.

export const cookieName = "es_remote"
const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

export const createPairingCode = () =>
  Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join("")).join("-")

export const normalizePairingCode = (value: string) => value.toUpperCase().replace(/[\s-]/g, "")

const digest = (value: string) => createHash("sha256").update(value).digest()

export const pairingMatches = (expected: string, supplied: string) =>
  timingSafeEqual(digest(normalizePairingCode(expected)), digest(normalizePairingCode(supplied)))

const signature = (code: string, nonce: string) =>
  createHmac("sha256", normalizePairingCode(code)).update(`es-remote-v1:${nonce}`).digest("base64url")

export const issueCookie = (code: string) => {
  const nonce = randomBytes(18).toString("base64url")
  return `${nonce}.${signature(code, nonce)}`
}

export const cookieValid = (code: string, headers: IncomingHttpHeaders) => {
  const value = headers.cookie
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1)
  const [nonce, mac, extra] = value?.split(".") ?? []
  if (!nonce || !mac || extra !== undefined) return false
  const expected = Buffer.from(signature(code, nonce))
  const supplied = Buffer.from(mac)
  return expected.length === supplied.length && timingSafeEqual(expected, supplied)
}

// Plain HTTP carries the pairing cookie, so remote listeners are limited to
// loopback (adb reverse / emulator) and tailnet addresses, which ride an
// encrypted WireGuard tunnel. Wildcard and LAN binds are refused.
export const remoteListenHost = (value: string) => {
  const host = value.replace(/^\[(.*)\]$/, "$1").toLowerCase()
  const version = isIP(host)
  if (version === 4) {
    const [a, b] = host.split(".").map(Number)
    if (a === 127 || (a === 100 && b >= 64 && b <= 127)) return host
    return undefined
  }
  if (version === 6 && (host === "::1" || /^fd7a:115c:a1e0:/.test(host))) return host
  return undefined
}

export const loopbackHost = (host: string) => host === "::1" || host.startsWith("127.")

export const pairingCsp =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

/** The exact command that prints the gateway's code file on its own host, quoted for that host's shell. */
export const codeCommand = (file: string, platform: string = process.platform) =>
  platform === "win32" ? `Get-Content -LiteralPath '${file.replaceAll("'", "''")}'` : `cat -- '${file.replaceAll("'", "'\\''")}'`

const html = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")

// The page names where the code comes from, never the code. A path with control characters cannot be
// shown as one copyable command, so it gets the generic wording.
export const pairingPage = (error = "", codeFile?: string, platform: string = process.platform) => {
  const command = codeFile && !/[\u0000-\u001f\u007f]/.test(codeFile) ? html(codeCommand(codeFile, platform)) : undefined
  return `<!doctype html>
<html lang="en" dir="ltr">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Pair device · Editspace</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#171819;color:#ececec}
main{max-inline-size:34rem;margin-inline:auto;padding-block:8vh;padding-inline:24px}
h1{font-size:22px;font-weight:600;margin:0 0 8px}
p{color:#a8a8a8;margin:0 0 20px}
ol{padding-inline-start:24px;color:#c6c6c6;margin:0 0 24px}li{margin-block:10px}pre{padding:12px;background:#0f1011;border:1px solid #444;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;color:#ececec;font:14px/1.6 ui-monospace,monospace}code{user-select:all}strong{color:#ececec}
label{display:block;font-size:14px;margin-block-end:6px}
input{box-sizing:border-box;inline-size:100%;font:18px ui-monospace,monospace;letter-spacing:.08em;padding:12px;border-radius:8px;border:1px solid #444;background:#0f1011;color:inherit}
button{margin-block-start:16px;inline-size:100%;padding:12px;font:inherit;font-weight:600;border:0;border-radius:8px;background:#ececec;color:#171819}
.error{color:#ff9b8f;margin-block-start:12px}
</style>
<main>
<h1>Pair this device</h1>
<p>Get the code from <strong>the PC hosting this gateway</strong>, then enter it below.</p>
${command ? `<ol>
<li>On the host PC, open a terminal locally or connect to that PC over SSH. Do not run this on the device you are pairing.</li>
<li>Run this exact command:<pre><code>${command}</code></pre></li>
<li>Copy the code it prints, paste it below, and press <strong>Pair</strong>.</li>
</ol>` : `<p>This gateway's code was set when it was started (for example in <code>ES_REMOTE_PAIRING_CODE</code>). Ask the person who started it for that code.</p>`}
<p>If you cannot reach the host PC, ask its owner for the code. Pairing applies to this browser or app only; signing in through a separate browser does not pair the desktop app.</p>
<form method="post" action="/__es/pair">
<label for="code">Pairing code</label>
<input id="code" name="code" dir="ltr" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required autofocus>
${error ? `<p class="error" role="alert">${error}</p>` : ""}
<button type="submit">Pair</button>
</form>
</main>
</html>`
}
