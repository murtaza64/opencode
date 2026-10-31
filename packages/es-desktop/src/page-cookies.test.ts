import { expect, test } from "bun:test"
import type { Cookie } from "electron"
import { KEEP_SESSION_COOKIES_MS, persistentCopy } from "./page-cookies"

const now = 1_800_000_000_000
const cookie = (extra: Partial<Cookie>): Cookie => ({ name: "sid", value: "v", domain: "app.example.com", hostOnly: true, path: "/", secure: true, httpOnly: true, session: true, sameSite: "lax", ...extra })

test("a session cookie is kept as persistent for a week with its flags, path and scope unchanged", () => {
  expect(persistentCopy(cookie({}), now)).toEqual({ url: "https://app.example.com/", name: "sid", value: "v", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: (now + KEEP_SESSION_COOKIES_MS) / 1000 })
})

test("a domain cookie keeps its domain; a host-only cookie stays host-only", () => {
  expect(persistentCopy(cookie({ domain: ".example.com", hostOnly: false }), now)).toMatchObject({ url: "https://example.com/", domain: ".example.com" })
  expect(persistentCopy(cookie({}), now)).not.toHaveProperty("domain")
})

test("path, non-secure and sameSite none/strict carry over", () => {
  expect(persistentCopy(cookie({ path: "/auth", secure: false, httpOnly: false, sameSite: "no_restriction" }), now))
    .toMatchObject({ url: "http://app.example.com/auth", path: "/auth", secure: false, httpOnly: false, sameSite: "no_restriction" })
  expect(persistentCopy(cookie({ sameSite: "strict" }), now)).toMatchObject({ sameSite: "strict" })
})

test("a persistent cookie is left alone", () => {
  expect(persistentCopy(cookie({ session: false, expirationDate: now / 1000 + 60 }), now)).toBeUndefined()
})
