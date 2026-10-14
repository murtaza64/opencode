import { expect, test } from "bun:test"
import { createImageStore } from "./image-store"

test("content-addressed images are idempotent and removable", async () => {
  const store = createImageStore()
  const image = { url: "data:image/png;base64,aGVsbG8=", mime: "image/png", filename: "one.png" }
  const key = await store.put(image, "draft-a")
  expect(key).toMatch(/^[a-f0-9]{64}$/)
  expect(await store.put(image, "draft-a")).toBe(key)
  expect(await store.get(key)).toMatchObject(image)
  await store.remove([key], "draft-a")
  expect(await store.get(key)).toBeUndefined()
  if (typeof indexedDB === "undefined") expect(store.volatile).toBe(true)
})

test("a blob shared by two drafts survives until the last draft releases it", async () => {
  const store = createImageStore()
  const image = { url: "data:image/png;base64,c2hhcmVk", mime: "image/png", filename: "shared.png" }
  const key = await store.put(image, "predecessor")
  expect(await store.put(image, "successor")).toBe(key)
  await store.remove([key], "predecessor")
  expect(await store.get(key)).toMatchObject(image)
  await store.remove([key], "unrelated")
  expect(await store.get(key)).toMatchObject(image)
  await store.remove([key], "successor")
  expect(await store.get(key)).toBeUndefined()
})
