/* The app's own origin behind Cloudflare Access (a paired gateway page): an expired Access session reads "Sign in",
 * apart from offline/unreachable and from gateway re-pair (DD #897).
 *
 * Same-origin requests carry `X-Requested-With: XMLHttpRequest`, so Access answers an expired session with 401
 * instead of a 302 to its login page. That 401 is not JSON; the gateway's own refusals ("Pairing required",
 * "Sign-in needed") and Core's are JSON and keep their existing handling. A redirect followed to another origin (a
 * login page) counts too. Any later same-origin success clears the state. Nothing here reads or sets a cookie or
 * credential. */
import { createRoot, createSignal } from "solid-js"

export type AccessState = "ok" | "sign-in"

const store = createRoot(() => {
  const [state, setState] = createSignal<AccessState>("ok")
  return { state, setState }
})
let waiters: (() => void)[] = []

export const accessState = store.state

/** Resolves once Access is not asking for sign-in (now, if it is not). */
export const whenSignedIn = () =>
  store.state() === "ok" ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve))

const set = (next: AccessState) => {
  if (store.state() === next) return
  store.setState(next)
  if (next !== "ok") return
  const ready = waiters
  waiters = []
  ready.forEach((resolve) => resolve())
}

/** Classifies one same-origin response: Access sign-in, success, or neither (left to its caller). */
export const observeAccess = (response: Response, origin: string) => {
  const crossRedirect = response.redirected && URL.parse(response.url)?.origin !== origin
  const json = response.headers.get("content-type")?.includes("application/json")
  if (response.type === "opaqueredirect" || crossRedirect || (response.status === 401 && !json)) return set("sign-in")
  if (response.ok) set("ok")
}

const sameOrigin = (input: RequestInfo | URL, origin: string) => {
  const url = input instanceof Request ? input.url : String(input)
  return URL.parse(url, origin)?.origin === origin
}

/** Wraps `target.fetch` once: same-origin requests get the header and their responses are observed. */
export const installAccessAuth = (target: { fetch: typeof fetch; location?: { origin: string } } = globalThis as never) => {
  const origin = target.location?.origin
  if (!origin || (target.fetch as { accessAuth?: true }).accessAuth) return
  const inner = target.fetch.bind(target)
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!sameOrigin(input, origin)) return inner(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (!headers.has("x-requested-with")) headers.set("x-requested-with", "XMLHttpRequest")
    const response = await inner(input, { ...init, headers })
    observeAccess(response, origin)
    return response
  }) as typeof fetch & { accessAuth?: true }
  wrapped.accessAuth = true
  target.fetch = wrapped
}

/** Test seam. */
export const resetAccessAuth = () => {
  store.setState("ok")
  waiters = []
}
