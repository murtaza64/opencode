import { describe, expect, test } from "bun:test"
import { InputImageValidation } from "../src/v1/input-image-validation"

// Disposable 2×3 images generated with Pillow; extended WebP includes alpha and EXIF orientation.
const fixtures = {
  png: {
    mime: "image/png",
    data: atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGOM6rnEwMDAxAAGUAoAIIQBvq4LkJkAAAAASUVORK5CYII=",
    ),
  },
  jpeg: {
    mime: "image/jpeg",
    data: atob(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCWiiivpjwz/9k=",
    ),
  },
  progressive: {
    mime: "image/jpeg",
    data: atob(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAL/xAAVAQEBAAAAAAAAAAAAAAAAAAAEBf/aAAwDAQACEAMQAAABoUw//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABDz/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=",
    ),
  },
  gif: { mime: "image/gif", data: atob("R0lGODdhAgADAIEAAFqM0gAAAAAAAAAAACwAAAAAAgADAAAIBgABCBwYEAA7") },
  vp8: {
    mime: "image/webp",
    data: atob("UklGRjYAAABXRUJQVlA4ICoAAADwAQCdASoCAAMAAUAmJaACdLoB+AAF9AAA2m/8zRMcx+1f/4VfG5CwoAA="),
  },
  vp8l: { mime: "image/webp", data: atob("UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAAAdQxmpVuv+BiOh/AAA=") },
  vp8x: {
    mime: "image/webp",
    data: atob(
      "UklGRnoAAABXRUJQVlA4WAoAAAAYAAAAAQAAAgAAQUxQSAcAAAAAf39/f39/AFZQOCAqAAAA8AEAnQEqAgADAAFAJiWgAnS6AfgABfQAANpv/M0THMftX/+FXxuQsKAARVhJRhoAAABNTQAqAAAACAABARIAAwAAAAEAAQAAAAAAAA==",
    ),
  },
  vp8xl: {
    mime: "image/webp",
    data: atob(
      "UklGRlIAAABXRUJQVlA4WAoAAAAYAAAAAQAAAgAAVlA4TBEAAAAvAYAAEAdQxmpVun+BiOh/AABFWElGGgAAAE1NACoAAAAIAAEBEgADAAAAAQABAAAAAAAA",
    ),
  },
}

const image = (fixture: { mime: string; data: string }) => ({
  mime: fixture.mime,
  url: `data:${fixture.mime};base64,${btoa(fixture.data)}`,
})
const integer = (value: number, size: number, little = false) =>
  String.fromCharCode(
    ...Array.from({ length: size }, (_, i) => Math.floor(value / 256 ** (little ? i : size - i - 1)) & 255),
  )
const replace = (data: string, offset: number, bytes: string) =>
  data.slice(0, offset) + bytes + data.slice(offset + bytes.length)
const check = (fixture: { mime: string; data: string }, data: string) =>
  InputImageValidation.issue([image({ mime: fixture.mime, data })])
const riff = (chunks: string) => "RIFF" + integer(chunks.length + 4, 4, true) + "WEBP" + chunks
const chunk = (type: string, data: string) =>
  type + integer(data.length, 4, true) + data + (data.length % 2 ? "\0" : "")
const padded = (length: number) => {
  const extra = length - fixtures.jpeg.data.length
  const count = Math.ceil(extra / 65537)
  const size = Math.floor(extra / count)
  const comments = Array.from({ length: count }, (_, i) => {
    const length = i === count - 1 ? extra - size * i : size
    return "\xff\xfe" + integer(length - 2, 2) + "\0".repeat(length - 4)
  }).join("")
  return image({ mime: "image/jpeg", data: "\xff\xd8" + comments + fixtures.jpeg.data.slice(2) })
}

describe("input image validation", () => {
  test.each(["iCCP", "zTXt", "iTXt"])("rejects compressed %s metadata before a decoder can inflate it", (type) => {
    const content = type === "iTXt" ? "profile\0\x01\0\0\0compressed" : "profile\0\0compressed"
    const metadata = integer(content.length, 4) + type + content + "\0\0\0\0"
    expect(check(fixtures.png, fixtures.png.data.slice(0, 33) + metadata + fixtures.png.data.slice(33))).toContain(
      "Compressed PNG metadata",
    )
  })
  test("publishes the fixed admission contract", () => {
    expect(InputImageValidation.Support).toEqual({
      version: 1,
      encoding: "data-url",
      mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
      maxCount: 8,
      maxBytes: 5242880,
      maxTotalBytes: 10485760,
      maxWidth: 8192,
      maxHeight: 8192,
      maxPixels: 16777216,
      animated: false,
      compressedMetadata: false,
    })
  })

  test.each(Object.entries(fixtures))("accepts a complete %s image", (_, fixture) => {
    expect(InputImageValidation.issue([image(fixture)])).toBeUndefined()
  })

  test.each(Object.entries(fixtures))("rejects every truncated prefix of %s without throwing", (_, fixture) => {
    for (let length = 0; length < fixture.data.length; length++) {
      expect(check(fixture, fixture.data.slice(0, length))).toBeString()
    }
  })

  test("accepts an empty list and eight repeated images without mutating input", () => {
    expect(InputImageValidation.issue([])).toBeUndefined()
    const images = Object.freeze(Array.from({ length: 8 }, () => Object.freeze(image(fixtures.png))))
    expect(InputImageValidation.issue(images)).toBeUndefined()
  })

  test("counts repeated images toward the count limit", () => {
    expect(InputImageValidation.issue(Array(9).fill(image(fixtures.png)))).toContain("At most 8")
  })

  test("accepts exact individual and aggregate raw byte limits", () => {
    const value = padded(5242880)
    expect(InputImageValidation.issue([value, value])).toBeUndefined()
  })

  test("rejects one raw byte over the individual limit, even with the same base64 length", () => {
    expect(InputImageValidation.issue([padded(5242881)])).toContain("exceeds 5242880 bytes")
  })

  test("rejects oversized encoded data before parsing it", () => {
    expect(
      InputImageValidation.issue([{ mime: "image/png", url: "data:image/png;base64," + "A".repeat(6990509) }]),
    ).toContain("exceeds 5242880 bytes")
  })

  test("counts repeated images toward the total byte limit", () => {
    const value = padded(5242880)
    expect(InputImageValidation.issue([value, value, image(fixtures.gif)])).toContain("10485760 total bytes")
  })

  test("sums different images toward the total byte limit", () => {
    expect(InputImageValidation.issue([padded(5242880), padded(5242800), image(fixtures.jpeg)])).toContain(
      "10485760 total bytes",
    )
  })

  test.each(["image/svg+xml", "image/bmp", "image/jpg", "IMAGE/PNG"])("rejects unsupported MIME %s", (mime) => {
    expect(InputImageValidation.issue([{ ...image(fixtures.png), mime }])).toContain("Unsupported image MIME")
  })

  test.each([
    "https://example.com/image.png",
    "file:///image.png",
    "blob:local",
    "data:image/jpeg;base64,AAAA",
    "data:image/png;charset=utf-8;base64,AAAA",
    "data:image/png,raw",
  ])("rejects a nonmatching inline base64 URL: %s", (url) => {
    expect(InputImageValidation.issue([{ mime: "image/png", url }])).toContain("matching their MIME")
  })

  test.each([
    "",
    "A",
    "AAA",
    "A===",
    "====",
    "AA=A",
    "AA-_",
    "AA A",
    "AAAA\n",
    "AA=\n",
    "AAA\r",
    "AAA\u2028",
    "AB==",
    "AAB=",
  ])("rejects malformed or noncanonical base64: %s", (encoded) => {
    expect(InputImageValidation.issue([{ mime: "image/png", url: `data:image/png;base64,${encoded}` }])).toContain(
      "base64",
    )
  })

  test.each(Object.entries(fixtures))("rejects a wrong signature for %s", (_, fixture) => {
    expect(check(fixture, replace(fixture.data, 0, "?"))).toContain("metadata")
  })

  test("rejects PNG bytes declared as JPEG despite matching URL and declared MIME", () => {
    expect(check(fixtures.jpeg, fixtures.png.data)).toContain("JPEG metadata")
  })

  test.each([
    [0, 3, "positive"],
    [8193, 3, "dimensions exceed"],
    [2, 8193, "dimensions exceed"],
    [4097, 4096, "dimensions exceed"],
    [4294967295, 3, "dimensions exceed"],
  ] as const)("rejects PNG dimensions %i×%i", (width, height, message) => {
    expect(check(fixtures.png, replace(fixtures.png.data, 16, integer(width, 4) + integer(height, 4)))).toContain(
      message,
    )
  })

  test("accepts exact dimension and pixel bounds at the metadata layer", () => {
    expect(check(fixtures.png, replace(fixtures.png.data, 16, integer(8192, 4) + integer(2048, 4)))).toBeUndefined()
  })

  test("rejects duplicate PNG headers and APNG frame control", () => {
    const data = fixtures.png.data
    expect(check(fixtures.png, data.slice(0, 33) + data.slice(8))).toContain("metadata")
    expect(check(fixtures.png, data.slice(0, 33) + "\0\0\0\0fcTL\0\0\0\0" + data.slice(33))).toContain("Animated PNG")
  })

  test("rejects PNG chunks whose declared length exceeds the container", () => {
    expect(check(fixtures.png, replace(fixtures.png.data, 33, integer(4294967295, 4)))).toContain("metadata")
  })

  test.each([fixtures.jpeg, fixtures.progressive])("checks JPEG SOF dimensions", (fixture) => {
    const offset = fixture.data.indexOf(fixture === fixtures.jpeg ? "\xff\xc0" : "\xff\xc2")
    expect(check(fixture, replace(fixture.data, offset + 5, integer(8193, 2)))).toContain("dimensions exceed")
    expect(check(fixture, replace(fixture.data, offset + 5, integer(4097, 2) + integer(4096, 2)))).toContain(
      "dimensions exceed",
    )
  })

  test("rejects duplicate JPEG frames and deferred dimensions after entropy data", () => {
    const data = fixtures.jpeg.data
    const offset = data.indexOf("\xff\xc0")
    expect(check(fixtures.jpeg, data.slice(0, -2) + data.slice(offset, offset + 19) + "\xff\xd9")).toContain(
      "Multiple JPEG",
    )
    expect(check(fixtures.jpeg, data.slice(0, -2) + "\xff\xdc\0\x04\xff\xff\xff\xd9")).toContain("DNL")
  })

  test("rejects invalid and overflowing JPEG segment lengths", () => {
    expect(check(fixtures.jpeg, replace(fixtures.jpeg.data, 4, "\0\x01"))).toContain("metadata")
    expect(check(fixtures.jpeg, replace(fixtures.jpeg.data, 4, "\xff\xff"))).toContain("metadata")
  })

  test("bounds both GIF logical and embedded frame dimensions", () => {
    expect(check(fixtures.gif, replace(fixtures.gif.data, 6, integer(8193, 2, true)))).toContain("dimensions exceed")
    expect(check(fixtures.gif, replace(fixtures.gif.data, 30, integer(8193, 2, true)))).toContain("dimensions exceed")
    expect(check(fixtures.gif, replace(fixtures.gif.data, 30, integer(3, 2, true)))).toContain("logical canvas")
    expect(check(fixtures.gif, replace(fixtures.gif.data, 26, integer(1, 2, true)))).toContain("logical canvas")
  })

  test("rejects GIF animation and unterminated subblocks", () => {
    const data = fixtures.gif.data
    expect(check(fixtures.gif, data.slice(0, -1) + data.slice(25))).toContain("Animated GIF")
    expect(check(fixtures.gif, data.slice(0, 25) + "\x21\xff\x0bNETSCAPE2.0\x03\x01\0\0\0" + data.slice(25))).toContain(
      "Animated GIF",
    )
    expect(check(fixtures.gif, replace(data, 36, "\xff"))).toContain("metadata")
  })

  test("bounds lossy and lossless WebP frame dimensions", () => {
    expect(check(fixtures.vp8, replace(fixtures.vp8.data, 26, integer(8193, 2, true)))).toContain("dimensions exceed")
    expect(check(fixtures.vp8l, replace(fixtures.vp8l.data, 21, integer(8192, 4, true)))).toContain("dimensions exceed")
    expect(check(fixtures.vp8l, replace(fixtures.vp8l.data, 21, integer(4096 + 4095 * 16384, 4, true)))).toContain(
      "dimensions exceed",
    )
  })

  test.each([fixtures.vp8x, fixtures.vp8xl])(
    "checks WebP canvas and embedded frame dimensions independently",
    (fixture) => {
      expect(check(fixture, replace(fixture.data, 24, integer(8192, 3, true)))).toContain("dimensions exceed")
      expect(check(fixture, replace(fixture.data, 24, integer(0, 3, true)))).toContain("must match")
      const offset = fixture.data.indexOf(fixture === fixtures.vp8x ? "VP8 " : "VP8L")
      const forged =
        fixture === fixtures.vp8x
          ? replace(fixture.data, offset + 14, integer(8193, 2, true))
          : replace(fixture.data, offset + 9, integer(8192, 4, true))
      expect(check(fixture, forged)).toContain("dimensions exceed")
    },
  )

  test("rejects WebP animation flags and chunks even if their canvas is small", () => {
    expect(check(fixtures.vp8x, replace(fixtures.vp8x.data, 20, "\x1a"))).toContain("Animated WebP")
    expect(check(fixtures.vp8, riff(fixtures.vp8.data.slice(12) + chunk("ANMF", "")))).toContain("Animated WebP")
    expect(check(fixtures.vp8, riff(fixtures.vp8.data.slice(12) + chunk("ANIM", "")))).toContain("Animated WebP")
  })

  test("rejects duplicate WebP frames and overflowing RIFF chunk lengths", () => {
    expect(check(fixtures.vp8, riff(fixtures.vp8.data.slice(12) + fixtures.vp8l.data.slice(12)))).toContain(
      "Multiple WebP",
    )
    expect(check(fixtures.vp8, replace(fixtures.vp8.data, 16, "\xff\xff\xff\xff"))).toContain("metadata")
    expect(check(fixtures.vp8, replace(fixtures.vp8.data, 4, "\0\0\0\0"))).toContain("metadata")
  })

  test("allows bounded ancillary metadata without treating embedded signatures as frames", () => {
    expect(
      check(fixtures.jpeg, fixtures.jpeg.data.slice(0, 2) + "\xff\xe2\0\x09profile" + fixtures.jpeg.data.slice(2)),
    ).toBeUndefined()
    expect(check(fixtures.vp8x, riff(fixtures.vp8x.data.slice(12) + chunk("ICCP", "profile VP8L")))).toBeUndefined()
    expect(
      check(fixtures.gif, fixtures.gif.data.slice(0, 25) + "\x21\xfe\x07comment\0" + fixtures.gif.data.slice(25)),
    ).toBeUndefined()
  })
})
