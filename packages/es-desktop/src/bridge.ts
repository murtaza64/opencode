/* A bridged host's credentials, held only in the main process: the Cloudflare Access service token
 * (Keychain) that lets the laptop through the host's Access gate, and the host gateway's pairing cookie
 * (obtained once with the pairing code, kept encrypted on disk). Upstream requests from that host's
 * listener carry them; no renderer, log, URL or mail ever does. */
import { execFile } from "node:child_process"
import { readFile, rename, rm, writeFile } from "node:fs/promises"

export type Access = { clientId: string; clientSecret: string }
export type BridgeStore = {
  access: () => Promise<Access | undefined>
  cookie: () => Promise<string | undefined>
  /** Throws when the cookie cannot be kept safely (no OS encryption); never stores plaintext. */
  saveCookie: (value: string) => Promise<void>
  /** Deletes the stored cookie; absent is fine. */
  forgetCookie: () => Promise<void>
}
export type PairResult = "paired" | "wrong-code" | "throttled" | "sign-in-needed" | "unreachable" | "unavailable"

const COOKIE = /^[A-Za-z0-9._~-]{16,512}$/

export const createBridge = (options: { origin: string; store: BridgeStore; fetch?: typeof fetch }) => {
  const request = options.fetch ?? fetch
  const state: { access?: Access; cookie?: string } = {}
  // The token and the cookie load independently: an unreadable cookie means "pair again", never a lost token.
  const ready = Promise.all([
    options.store.access().then((access) => (state.access = access), () => undefined),
    options.store.cookie().then((cookie) => (state.cookie = cookie && COOKIE.test(cookie) ? cookie : undefined), () => undefined),
  ]).then(() => undefined)
  const accessHeaders = () => (state.access ? { "cf-access-client-id": state.access.clientId, "cf-access-client-secret": state.access.clientSecret } : undefined)
  return {
    ready,
    /** Whether this machine has a service token for the host at all. */
    configured: () => !!state.access,
    paired: () => !!state.access && !!state.cookie,
    /** Headers for one upstream request; undefined until both the token and the pairing cookie exist. */
    headers: (): Record<string, string> | undefined => {
      const access = accessHeaders()
      return access && state.cookie ? { ...access, cookie: `es_remote=${state.cookie}` } : undefined
    },
    /** Pairs this machine with the host's gateway once; the code goes only to that gateway. */
    pair: async (code: string): Promise<PairResult> => {
      const access = accessHeaders()
      if (!access) return "sign-in-needed"
      const response = await request(`${options.origin}/__es/pair`, {
        method: "POST",
        redirect: "manual",
        headers: { ...access, origin: options.origin, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code }).toString(),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined)
      if (!response) return "unreachable"
      await response.body?.cancel()
      if (response.status === 401) return "wrong-code"
      if (response.status === 429) return "throttled"
      const value = response.status === 303 ? cookieOf(response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""]) : undefined
      if (value) {
        // Paired upstream but not storable safely here: not paired on this machine.
        const saved = await options.store.saveCookie(value).then(() => true, () => false)
        if (!saved) return "unavailable"
        state.cookie = value
        return "paired"
      }
      // A redirect elsewhere (the Access login) or a refusal at the gate: the token is not accepted.
      return [301, 302, 303, 307, 308, 403].includes(response.status) ? "sign-in-needed" : "unreachable"
    },
    /** Drops this machine's pairing (Forget pairing, or the gateway no longer honours it); the token stays.
     * With `used` (the cookie header a refused request carried), only if that is still the current pairing. */
    forget: async (used?: string) => {
      if (used !== undefined && used !== `es_remote=${state.cookie}`) return
      state.cookie = undefined
      await options.store.forgetCookie()
    },
  }
}

export type Bridge = ReturnType<typeof createBridge>

const cookieOf = (values: string[]) =>
  values.map((value) => /^es_remote=([^;]+)/.exec(value)?.[1]).find((value): value is string => !!value && COOKIE.test(value))

/** The service token from the login Keychain: service `<item>`, accounts `client-id` and `client-secret`. */
export const keychainAccess = (item: string) => async (): Promise<Access | undefined> => {
  const read = (account: string) =>
    new Promise<string | undefined>((resolve) =>
      execFile("security", ["find-generic-password", "-s", item, "-a", account, "-w"], { timeout: 10_000 }, (error, stdout) =>
        resolve(error ? undefined : stdout.trim() || undefined),
      ),
    )
  const [clientId, clientSecret] = await Promise.all([read("client-id"), read("client-secret")])
  return clientId && clientSecret ? { clientId, clientSecret } : undefined
}

/** The pairing cookie, encrypted with the OS key store (Electron safeStorage) in one owner-only file.
 * Without OS encryption nothing is read or written: the host stays unpaired. */
export const encryptedCookie = (file: string, crypto: { available: () => boolean; encrypt: (value: string) => Buffer; decrypt: (value: Buffer) => string }) => ({
  cookie: async () => (crypto.available() ? readFile(file).then((data) => crypto.decrypt(data), () => undefined) : undefined),
  saveCookie: async (value: string) => {
    if (!crypto.available()) throw new Error("OS encryption unavailable")
    await writeFile(`${file}.tmp`, crypto.encrypt(value), { mode: 0o600 })
    await rename(`${file}.tmp`, file)
  },
  forgetCookie: async () => rm(file, { force: true }),
})
