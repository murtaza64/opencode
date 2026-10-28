import { afterEach, describe, expect, test } from "bun:test"
import { filamentEnabled, FLAG_KEY } from "./flag"

// Minimal location/localStorage stand-ins: the flag reads only these two globals.
const setURL = (search: string) => { (globalThis as { location?: unknown }).location = { search } }
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
}
afterEach(() => { store.clear(); setURL("") })

describe("filament flag", () => {
  test("off by default", () => {
    expect(filamentEnabled()).toBe(false)
  })
  test("deliberate localStorage opt-in enables", () => {
    store.set(FLAG_KEY, "1")
    expect(filamentEnabled()).toBe(true)
  })
  test("?filament=1 enables this load only and never writes storage", () => {
    setURL("?filament=1")
    expect(filamentEnabled()).toBe(true)
    expect(store.has(FLAG_KEY)).toBe(false)
    setURL("")
    expect(filamentEnabled()).toBe(false)
  })
  test("?filament=0 suppresses an opted-in app for this load without clearing the opt-in", () => {
    store.set(FLAG_KEY, "1")
    setURL("?filament=0")
    expect(filamentEnabled()).toBe(false)
    expect(store.get(FLAG_KEY)).toBe("1")
  })
})
