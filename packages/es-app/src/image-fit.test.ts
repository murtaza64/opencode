import { expect, test } from "bun:test"
import { defaultImageCapability, fitImage } from "./image-fit"

test("keeps conforming images without re-encoding", () => {
  expect(fitImage({ width: 64, height: 64, bytes: 1024, mime: "image/png" }, defaultImageCapability)).toEqual({ action: "keep" })
})

test("scales dimensions to fit width, height and pixel limits while preserving aspect", () => {
  const plan = fitImage({ width: 9000, height: 6000, bytes: 100, mime: "image/png" }, defaultImageCapability)
  expect(plan.action).toBe("encode")
  if (plan.action !== "encode") return
  expect(plan.width).toBeLessThanOrEqual(8192)
  expect(plan.height).toBeLessThanOrEqual(8192)
  expect(plan.width * plan.height).toBeLessThanOrEqual(16_777_216)
  expect(Math.abs(plan.width / plan.height - 1.5)).toBeLessThan(0.001)
  expect(fitImage({ width: 9000, height: 1000, bytes: 100, mime: "image/png" }, defaultImageCapability)).toMatchObject({ action: "encode", width: 8192 })
  expect(fitImage({ width: 1000, height: 9000, bytes: 100, mime: "image/png" }, defaultImageCapability)).toMatchObject({ action: "encode", height: 8192 })
})

test("oversize bytes trigger PNG then descending JPEG quality attempts", () => {
  expect(fitImage({ width: 64, height: 64, bytes: 5_242_881, mime: "image/png" }, defaultImageCapability)).toEqual({
    action: "encode", width: 64, height: 64,
    attempts: [{ mime: "image/png" }, { mime: "image/jpeg", quality: 0.92 }, { mime: "image/jpeg", quality: 0.85 }, { mime: "image/jpeg", quality: 0.75 }, { mime: "image/jpeg", quality: 0.6 }],
  })
  expect(fitImage({ width: 64, height: 64, bytes: 5_242_881, mime: "image/jpeg" }, defaultImageCapability)).toMatchObject({
    attempts: [{ mime: "image/jpeg", quality: 0.92 }, { mime: "image/jpeg", quality: 0.85 }, { mime: "image/jpeg", quality: 0.75 }, { mime: "image/jpeg", quality: 0.6 }],
  })
})

test("unsupported image formats are encoded", () => {
  const plan = fitImage({ width: 64, height: 64, bytes: 1024, mime: "image/tiff" }, defaultImageCapability)
  expect(plan.action).toBe("encode")
  if (plan.action === "encode") expect(plan.attempts[0]).toEqual({ mime: "image/png" })
})

test("running total cap triggers encoding", () => {
  expect(fitImage({ width: 64, height: 64, bytes: 1000, mime: "image/png" }, defaultImageCapability, 10_485_000)).toMatchObject({ action: "encode" })
})
