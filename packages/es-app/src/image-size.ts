// Natural image dimensions read from a base64 data URL's header bytes, so a
// preview can reserve its exact box before the browser decodes the image.
// Cached by URL: a bubble re-rendering on every streamed token never re-parses.
export type ImageSize = { width: number; height: number }

const cache = new Map<string, ImageSize | null>()

export const imageSize = (url: string): ImageSize | undefined => {
  const cached = cache.get(url)
  if (cached !== undefined) return cached ?? undefined
  const size = parse(url)
  if (cache.size > 200) cache.delete(cache.keys().next().value!)
  cache.set(url, size ?? null)
  return size
}

const parse = (url: string) => {
  const comma = url.indexOf(",")
  if (!url.startsWith("data:image/") || comma < 0 || !url.slice(0, comma).endsWith(";base64")) return
  const body = url.slice(comma + 1)
  // Headers sit in the first bytes for PNG/GIF/WebP; JPEG's frame header can follow EXIF, so grow the window.
  for (let chars = 64; ; chars *= 16) {
    const bytes = decode(body, chars)
    if (!bytes) return
    const size = png(bytes) ?? gif(bytes) ?? webp(bytes) ?? jpeg(bytes)
    if (size !== "more") return size && size.width > 0 && size.height > 0 ? size : undefined
    if (chars >= body.length) return
  }
}

const decode = (body: string, chars: number) => {
  try {
    const binary = atob(body.slice(0, Math.min(body.length, chars - (chars % 4))))
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return undefined
  }
}

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!
const ascii = (b: Uint8Array, i: number, text: string) => [...text].every((char, k) => b[i + k] === char.charCodeAt(0))

const png = (b: Uint8Array) =>
  b.length >= 24 && b[0] === 0x89 && ascii(b, 1, "PNG") && ascii(b, 12, "IHDR")
    ? { width: be32(b, 16), height: be32(b, 20) } : undefined

const gif = (b: Uint8Array) =>
  b.length >= 10 && ascii(b, 0, "GIF8") ? { width: le16(b, 6), height: le16(b, 8) } : undefined

const webp = (b: Uint8Array) => {
  if (b.length < 30 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return
  if (ascii(b, 12, "VP8X")) return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) }
  if (ascii(b, 12, "VP8L")) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
  }
  if (ascii(b, 12, "VP8 ")) return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff }
}

const jpeg = (b: Uint8Array): ImageSize | "more" | undefined => {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return
  let i = 2
  while (i + 9 <= b.length) {
    if (b[i] !== 0xff) return
    const marker = b[i + 1]!
    // SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { width: be16(b, i + 7), height: be16(b, i + 5) }
    i += 2 + be16(b, i + 2)
  }
  return "more"
}
