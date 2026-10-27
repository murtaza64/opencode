import { expect, test } from "bun:test"
import { imageSize } from "./image-size"

const url = (mime: string, bytes: number[]) => `data:${mime};base64,${btoa(String.fromCharCode(...bytes))}`
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const chars = (text: string) => [...text].map((char) => char.charCodeAt(0))

test("reads PNG dimensions from the IHDR chunk", () => {
  const bytes = [0x89, ...chars("PNG"), 13, 10, 26, 10, 0, 0, 0, 13, ...chars("IHDR"), ...be32(1600), ...be32(900), 8, 6, 0, 0, 0]
  expect(imageSize(url("image/png", bytes))).toEqual({ width: 1600, height: 900 })
})

test("reads GIF logical screen size", () => {
  expect(imageSize(url("image/gif", [...chars("GIF89a"), 0x40, 0x01, 0xf0, 0x00, 0, 0, 0]))).toEqual({ width: 320, height: 240 })
})

test("reads WebP extended header size", () => {
  const bytes = [...chars("RIFF"), 0, 0, 0, 0, ...chars("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0, 0x1f, 0x03, 0x00, 0x57, 0x02, 0x00]
  expect(imageSize(url("image/webp", bytes))).toEqual({ width: 800, height: 600 })
})

test("reads JPEG frame size past a large EXIF segment", () => {
  // Two 35 KB APP segments push the frame header beyond the first decode windows.
  const half = 35_000
  const split = [0xff, 0xd8,
    0xff, 0xe1, (half + 2) >> 8, (half + 2) & 255, ...new Array(half).fill(0),
    0xff, 0xe2, (half + 2) >> 8, (half + 2) & 255, ...new Array(half).fill(0),
    0xff, 0xc0, 0, 17, 8, 0x02, 0xd0, 0x05, 0x00, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  const encoded = `data:image/jpeg;base64,${Buffer.from(split).toString("base64")}`
  expect(imageSize(encoded)).toEqual({ width: 1280, height: 720 })
})

test("returns undefined for non-image or non-base64 URLs", () => {
  expect(imageSize("https://example.com/a.png")).toBeUndefined()
  expect(imageSize("data:image/svg+xml,<svg/>")).toBeUndefined()
  expect(imageSize(url("image/png", [1, 2, 3, 4]))).toBeUndefined()
})
