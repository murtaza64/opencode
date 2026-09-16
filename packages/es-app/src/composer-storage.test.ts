import { expect, test } from "bun:test"
import { createComposer } from "./composer"
import { composerStorage } from "./composer-storage"

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}
const key = 'es-app:composer:1:["ses_test","/fixture"]'

test("browser tabs keep independent drafts and never open durable storage", () => {
  const first = new MemoryStorage()
  const second = new MemoryStorage()
  const unavailable = () => {
    throw new Error("Browser must not access shared storage")
  }
  const tab = composerStorage("Mozilla Chrome/130", first, unavailable)
  tab.setItem(key, "first tab draft")
  expect(tab.getItem(key)).toBe("first tab draft")
  expect(composerStorage("Mozilla Chrome/130", second, unavailable).getItem(key)).toBeNull()
})

test("native durable snapshot takes precedence over stale tab data", () => {
  const tab = new MemoryStorage()
  const durable = new MemoryStorage()
  tab.setItem(key, "stale tab")
  durable.setItem(key, "durable unknown request")
  expect(composerStorage("Chrome/130 Electron/42.3.3", tab, () => durable).getItem(key)).toBe("durable unknown request")
})

test("native migration retains tab data until validated state is durably saved", () => {
  const tab = new MemoryStorage()
  const durable = new MemoryStorage()
  const original = createComposer("ses_test", "/fixture", { storage: tab })
  original.setText("task draft")
  original.setImages([{ id: "image", mime: "image/png", filename: "fixture.png", url: "data:image/png;base64,AA==" }])
  original.selectMode("aside")
  original.setText("aside draft")
  const saved = tab.getItem(key)
  const storage = composerStorage("Electron/42.3.3", tab, () => durable)
  expect(storage.getItem(key)).toBe(saved)
  expect(durable.getItem(key)).toBeNull()
  storage.setItem(key, saved!)
  expect(tab.getItem(key)).toBeNull()
  const restored = createComposer("ses_test", "/fixture", {
    storage: composerStorage("Electron/42.3.3", new MemoryStorage(), () => durable),
  })
  expect(restored.state.task.text).toBe("task draft")
  expect(restored.state.aside.text).toBe("aside draft")
  expect(restored.state.task.images[0]?.url).toBe("data:image/png;base64,AA==")
  expect(restored.state.mode).toBe("aside")
})

test("failed durable writes preserve the legacy snapshot and propagate a visible error", () => {
  const tab = new MemoryStorage()
  tab.setItem(key, "original")
  const durable = new MemoryStorage()
  const storage = composerStorage("Electron/42", tab, () => ({
    getItem: (key) => durable.getItem(key),
    removeItem: (key) => durable.removeItem(key),
    setItem: () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError")
    },
  }))
  expect(() => storage.setItem(key, "new")).toThrow("Quota exceeded")
  expect(tab.getItem(key)).toBe("original")
})

test("invalid saved request identity is not overwritten by newer typing or resubmitted", () => {
  const storage = new MemoryStorage()
  storage.setItem(key, '{"version":1,"admission":{"payload":{"requestID":"unknown"}}}')
  const composer = createComposer("ses_test", "/fixture", { storage })
  composer.setText("new typing")
  expect(composer.state.storageError).toContain("Cannot restore saved drafts")
  expect(composer.blockedReason()).toContain("request identity must be recovered")
  expect(storage.getItem(key)).toBe('{"version":1,"admission":{"payload":{"requestID":"unknown"}}}')
})

test("legacy cleanup failure does not replace a successfully saved image snapshot", () => {
  const durable = new MemoryStorage()
  const tab = new MemoryStorage()
  const storage = composerStorage(
    "Electron/42",
    {
      getItem: (key) => tab.getItem(key),
      setItem: (key, value) => tab.setItem(key, value),
      removeItem: () => {
        throw new Error("Tab storage unavailable")
      },
    },
    () => durable,
  )
  storage.setItem(key, "complete image snapshot")
  expect(durable.getItem(key)).toBe("complete image snapshot")
})
