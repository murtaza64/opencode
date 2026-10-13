import { expect, test } from "bun:test"
import { createImageStore } from "./image-store"

test("content-addressed images are idempotent and removable", async () => {
  const store = createImageStore()
  const image = { url: "data:image/png;base64,aGVsbG8=", mime: "image/png", filename: "one.png" }
  const key = await store.put(image)
  expect(key).toMatch(/^[a-f0-9]{64}$/)
  expect(await store.put(image)).toBe(key)
  expect(await store.get(key)).toMatchObject(image)
  await store.remove([key])
  expect(await store.get(key)).toBeUndefined()
  if (typeof indexedDB === "undefined") expect(store.volatile).toBe(true)
})
