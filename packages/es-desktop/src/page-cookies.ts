/* Personal (page-mode) sign-in across an app restart. Chromium drops session cookies (no expiry) at quit, so a site that
 * keeps its sign-in in one asks again after every restart. At a graceful quit, a page partition's session cookies are
 * set again as persistent, expiring in at most a week, in Chromium's own encrypted cookie store; nothing is written
 * anywhere else. App partitions keep normal session-cookie behaviour. */
import type { Cookie, CookiesSetDetails } from "electron"

export const KEEP_SESSION_COOKIES_MS = 7 * 24 * 60 * 60 * 1000

/** The set() details that store `cookie` again as persistent until `now` + 7 days, keeping its scope and flags.
 * Undefined for a cookie that is already persistent. */
export const persistentCopy = (cookie: Cookie, now: number): CookiesSetDetails | undefined => {
  if (!cookie.session) return undefined
  const host = cookie.domain?.replace(/^\./, "") ?? ""
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`,
    name: cookie.name,
    value: cookie.value,
    // A host-only cookie (no leading dot) is set without a domain, so it stays host-only.
    ...(cookie.hostOnly === false && cookie.domain ? { domain: cookie.domain } : {}),
    path: cookie.path ?? "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    expirationDate: (now + KEEP_SESSION_COOKIES_MS) / 1000,
  }
}

/** Keeps every session cookie of `partition` (a page partition) as persistent, then flushes the cookie store. */
export const keepSessionCookies = async (partition: Electron.Session, now = Date.now()) => {
  const cookies = await partition.cookies.get({})
  const copies = cookies.flatMap((cookie) => { const copy = persistentCopy(cookie, now); return copy ? [copy] : [] })
  await Promise.allSettled(copies.map((copy) => partition.cookies.set(copy)))
  return copies.length
}
