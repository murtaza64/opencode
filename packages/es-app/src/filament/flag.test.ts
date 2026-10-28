import { afterEach, describe, expect, test } from "bun:test"
import { livingActivity, LIVING_ACTIVITY_KEY, setLivingActivity } from "../appearance"

const store = new Map<string, string>()
const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
} })
afterEach(() => {
  setLivingActivity(false)
  store.clear()
  if (previous) Object.defineProperty(globalThis, "localStorage", previous)
  else Reflect.deleteProperty(globalThis, "localStorage")
})

describe("living activity appearance", () => {
  test("starts off and persists one choice for Filament and icon rows", () => {
    expect(livingActivity()).toBe(false)
    setLivingActivity(true)
    expect(livingActivity()).toBe(true)
    expect(localStorage.getItem(LIVING_ACTIVITY_KEY)).toBe("1")
    setLivingActivity(false)
    expect(livingActivity()).toBe(false)
    expect(localStorage.getItem(LIVING_ACTIVITY_KEY)).toBe("0")
  })
})
