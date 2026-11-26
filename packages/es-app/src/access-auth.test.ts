import { afterEach, expect, test } from "bun:test"
import { accessState, installAccessAuth, observeAccess, resetAccessAuth, whenSignedIn } from "./access-auth"

const origin = "https://agents.example"
afterEach(resetAccessAuth)

const target = (respond: (url: string, init?: RequestInit) => Response) => {
  const seen: { url: string; header: string | null }[] = []
  const value = {
    location: { origin },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      seen.push({ url, header: new Headers(init?.headers).get("x-requested-with") })
      return respond(url, init)
    }) as typeof fetch,
  }
  installAccessAuth(value)
  return { value, seen }
}

test("same-origin requests carry X-Requested-With; other origins are untouched", async () => {
  const { value, seen } = target(() => Response.json({}))
  await value.fetch("/oc/session")
  await value.fetch(`${origin}/es/api/state`)
  await value.fetch("https://other.example/x")
  expect(seen.map((item) => item.header)).toEqual(["XMLHttpRequest", "XMLHttpRequest", null])
})

test("Access's 401 (not JSON) reads Sign in; a later success clears it and releases waiters", async () => {
  let expired = true
  const { value } = target(() => expired ? new Response("Unauthorized", { status: 401, headers: { "content-type": "text/html" } }) : Response.json({}))
  await value.fetch("/oc/session")
  expect(accessState()).toBe("sign-in")
  let released = false
  const wait = whenSignedIn().then(() => { released = true })
  await Bun.sleep(0)
  expect(released).toBe(false)
  expired = false
  await value.fetch("/oc/session")
  await wait
  expect(accessState()).toBe("ok")
  expect(released).toBe(true)
})

test("the gateway's own JSON 401s (re-pair, sign-in needed) and Core's are not Access sign-in", () => {
  observeAccess(Response.json({ error: "Pairing required" }, { status: 401 }), origin)
  observeAccess(Response.json({ error: "Sign-in needed" }, { status: 401 }), origin)
  expect(accessState()).toBe("ok")
  // Offline / server trouble is not sign-in either.
  observeAccess(new Response("", { status: 503 }), origin)
  expect(accessState()).toBe("ok")
})

test("a redirect followed to another origin (a login page) reads Sign in", () => {
  const response = new Response("<html>", { status: 200 })
  Object.defineProperty(response, "redirected", { value: true })
  Object.defineProperty(response, "url", { value: "https://team.cloudflareaccess.com/cdn-cgi/access/login" })
  observeAccess(response, origin)
  expect(accessState()).toBe("sign-in")
})
