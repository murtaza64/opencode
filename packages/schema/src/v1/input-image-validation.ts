export * as InputImageValidation from "./input-image-validation"

export const Support = {
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
} as const

/** Bounds encoded bytes and decoder-visible dimensions; does not decompress pixels or verify checksums. */
export const issue = (images: readonly { mime: string; url: string }[]): string | undefined => {
  if (images.length > Support.maxCount) return `At most ${Support.maxCount} images are supported`
  let total = 0
  for (const [index, image] of images.entries()) {
    if (!Support.mimeTypes.some((mime) => mime === image.mime)) return `Unsupported image MIME: ${image.mime}`
    const prefix = `data:${image.mime};base64,`
    if (!image.url.startsWith(prefix)) return "Images must use inline base64 data URLs matching their MIME"
    const length = image.url.length - prefix.length
    if (length > 4 * Math.ceil(Support.maxBytes / 3)) return `Image exceeds ${Support.maxBytes} bytes`
    const encoded = image.url.slice(prefix.length)
    if (length === 0 || length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) return "Invalid image base64 encoding"
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
    if (encoded.slice(0, length - padding).includes("=")) return "Invalid image base64 encoding"
    const bytes = (length / 4) * 3 - padding
    if (bytes > Support.maxBytes) return `Image exceeds ${Support.maxBytes} bytes`
    total += bytes
    if (total > Support.maxTotalBytes) return `Images exceed ${Support.maxTotalBytes} total bytes`
    // The length/alphabet checks make atob safe; round-tripping rejects nonzero padding bits.
    const data = atob(encoded)
    if (btoa(data) !== encoded) return "Image base64 encoding must be canonical"
    const error =
      image.mime === "image/png"
        ? png(data)
        : image.mime === "image/jpeg"
          ? jpeg(data)
          : image.mime === "image/webp"
            ? webp(data)
            : gif(data)
    if (error) return `Image ${index + 1}: ${error}`
  }
  return undefined
}

// Callers check the containing header or segment bounds before reading integers.
const uint = (data: string, offset: number, size: number, little = false) => {
  let value = 0
  for (let i = 0; i < size; i++) value = value * 256 + data.charCodeAt(offset + (little ? size - 1 - i : i))
  return value
}

const dimensions = (width: number, height: number) => {
  if (!(width > 0 && height > 0)) return "Image dimensions must be positive"
  if (width > Support.maxWidth || height > Support.maxHeight || width * height > Support.maxPixels)
    return `Image dimensions exceed ${Support.maxWidth}×${Support.maxHeight} or ${Support.maxPixels} pixels`
  return undefined
}

const png = (data: string): string | undefined => {
  const invalid = "Invalid or truncated PNG metadata"
  if (data.slice(0, 8) !== "\x89PNG\r\n\x1a\n") return invalid
  let offset = 8
  let header = false
  let pixels = false
  let ended = false
  while (offset + 12 <= data.length) {
    const size = uint(data, offset, 4)
    const type = data.slice(offset + 4, offset + 8)
    const start = offset + 8
    const end = start + size + 4
    if (end > data.length || !/^[A-Za-z]{4}$/.test(type)) return invalid
    if (!header && type !== "IHDR") return invalid
    // Photon inflates metadata separately from the bounded raster dimensions.
    if (type === "iCCP" || type === "zTXt") return "Compressed PNG metadata is not supported"
    if (type === "iTXt") {
      const keywordEnd = data.indexOf("\0", start)
      if (keywordEnd < start || keywordEnd >= start + size - 2) return invalid
      if (data.charCodeAt(keywordEnd + 1) !== 0) return "Compressed PNG metadata is not supported"
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return "Animated PNG images are not supported"
    if (type === "IHDR") {
      if (header || size !== 13) return invalid
      const error = dimensions(uint(data, start, 4), uint(data, start + 4, 4))
      if (error) return error
      const depth = data.charCodeAt(start + 8)
      const color = data.charCodeAt(start + 9)
      const depths = color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16]
      if (
        ![0, 2, 3, 4, 6].includes(color) ||
        !depths.includes(depth) ||
        uint(data, start + 10, 2) !== 0 ||
        data.charCodeAt(start + 12) > 1
      )
        return invalid
      header = true
    } else if (type === "IDAT") {
      if (ended) return invalid
      pixels ||= size > 0
    } else if (type === "IEND") {
      return size === 0 && pixels && end === data.length ? undefined : invalid
    } else {
      if (pixels) ended = true
      if (type !== "PLTE" && type.charCodeAt(0) < 97) return "Unsupported PNG critical chunk"
      if (type === "PLTE" && (pixels || size === 0 || size > 768 || size % 3 !== 0)) return invalid
    }
    offset = end
  }
  return invalid
}

const jpeg = (data: string): string | undefined => {
  const invalid = "Invalid or truncated JPEG metadata"
  if (data.slice(0, 2) !== "\xff\xd8") return invalid
  let offset = 2
  let frame = false
  let scan = false
  let entropy = false
  while (offset < data.length) {
    if (entropy && data.charCodeAt(offset) !== 0xff) {
      offset++
      continue
    }
    if (data.charCodeAt(offset++) !== 0xff) return invalid
    while (offset < data.length && data.charCodeAt(offset) === 0xff) offset++
    if (offset === data.length) return invalid
    const marker = data.charCodeAt(offset++)
    if (entropy && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue
    entropy = false
    if (marker === 0xd9) return frame && scan && offset === data.length ? undefined : invalid
    if (marker === 0xdc) return "JPEG deferred dimensions (DNL) are not supported"
    if (marker === 0 || marker === 1 || (marker >= 0xd0 && marker <= 0xd8)) return invalid
    if (offset + 2 > data.length) return invalid
    const size = uint(data, offset, 2)
    if (size < 2 || offset + size > data.length) return invalid
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (![0xc0, 0xc1, 0xc2].includes(marker)) return "Unsupported JPEG frame encoding"
      if (frame) return "Multiple JPEG frames are not supported"
      if (size < 8 || data.charCodeAt(offset + 2) !== 8) return invalid
      const components = data.charCodeAt(offset + 7)
      if (![1, 3, 4].includes(components) || size !== 8 + 3 * components) return invalid
      const error = dimensions(uint(data, offset + 5, 2), uint(data, offset + 3, 2))
      if (error) return error
      frame = true
    }
    // Hierarchical JPEG can carry additional allocation dimensions outside SOF.
    if (marker === 0xde || marker === 0xdf || marker === 0xc8) return "Hierarchical JPEG is not supported"
    if (marker === 0xda) {
      if (!frame || size < 6) return invalid
      const components = data.charCodeAt(offset + 2)
      if (components < 1 || components > 4 || size !== 6 + 2 * components) return invalid
      scan = true
      entropy = true
    }
    offset += size
  }
  return invalid
}

const gif = (data: string): string | undefined => {
  const invalid = "Invalid or truncated GIF metadata"
  if (data.length < 13 || !["GIF87a", "GIF89a"].includes(data.slice(0, 6))) return invalid
  const width = uint(data, 6, 2, true)
  const height = uint(data, 8, 2, true)
  const error = dimensions(width, height)
  if (error) return error
  const packed = data.charCodeAt(10)
  let offset = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0)
  let frame = false
  while (offset < data.length) {
    const marker = data.charCodeAt(offset++)
    if (marker === 0x3b) return frame && offset === data.length ? undefined : invalid
    if (marker === 0x21) {
      if (offset + 2 > data.length) return invalid
      const label = data.charCodeAt(offset++)
      if (label === 0xf9) {
        if (offset + 6 > data.length || data.charCodeAt(offset) !== 4 || data.charCodeAt(offset + 5) !== 0)
          return invalid
        offset += 6
        continue
      }
      if (label === 0xff) {
        if (offset + 12 > data.length || data.charCodeAt(offset) !== 11) return invalid
        const app = data.slice(offset + 1, offset + 12)
        if (app === "NETSCAPE2.0" || app === "ANIMEXTS1.0") return "Animated GIF images are not supported"
        offset += 12
      } else if (label !== 0xfe) return "Unsupported GIF extension"
      const next = subblocks(data, offset)
      if (next === undefined) return invalid
      offset = next
      continue
    }
    if (marker !== 0x2c || offset + 9 > data.length) return invalid
    if (frame) return "Animated GIF images are not supported"
    const left = uint(data, offset, 2, true)
    const top = uint(data, offset + 2, 2, true)
    const frameWidth = uint(data, offset + 4, 2, true)
    const frameHeight = uint(data, offset + 6, 2, true)
    const error = dimensions(frameWidth, frameHeight)
    if (error) return error
    if (left + frameWidth > width || top + frameHeight > height) return "GIF frame exceeds its logical canvas"
    const local = data.charCodeAt(offset + 8)
    if (!(packed & 0x80) && !(local & 0x80)) return invalid
    offset += 9 + (local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0)
    if (offset + 2 > data.length || data.charCodeAt(offset) < 2 || data.charCodeAt(offset) > 8) return invalid
    offset++
    if (data.charCodeAt(offset) === 0) return invalid
    const next = subblocks(data, offset)
    if (next === undefined) return invalid
    offset = next
    frame = true
  }
  return invalid
}

const subblocks = (data: string, start: number): number | undefined => {
  let offset = start
  while (offset < data.length) {
    const size = data.charCodeAt(offset++)
    if (size === 0) return offset
    offset += size
  }
  return undefined
}

const webp = (data: string): string | undefined => {
  const invalid = "Invalid or truncated WebP metadata"
  if (
    data.length < 12 ||
    data.slice(0, 4) !== "RIFF" ||
    data.slice(8, 12) !== "WEBP" ||
    uint(data, 4, 4, true) !== data.length - 8
  )
    return invalid
  let offset = 12
  let canvas: readonly [number, number] | undefined
  let frame: readonly [number, number] | undefined
  let alpha: string | undefined
  let lossless = false
  while (offset + 8 <= data.length) {
    const type = data.slice(offset, offset + 4)
    const size = uint(data, offset + 4, 4, true)
    const start = offset + 8
    const end = start + size + (size % 2)
    if (end > data.length) return invalid
    if (type === "ANIM" || type === "ANMF") return "Animated WebP images are not supported"
    if (type === "VP8X") {
      if (offset !== 12 || size !== 10) return invalid
      const flags = data.charCodeAt(start)
      if (flags & 2) return "Animated WebP images are not supported"
      if (flags & 0xc1 || uint(data, start + 1, 3) !== 0) return invalid
      canvas = [uint(data, start + 4, 3, true) + 1, uint(data, start + 7, 3, true) + 1]
      const error = dimensions(...canvas)
      if (error) return error
    }
    if (type === "VP8 " || type === "VP8L") {
      if (frame) return "Multiple WebP frames are not supported"
      lossless = type === "VP8L"
      if (lossless) {
        if (size <= 5 || data.charCodeAt(start) !== 0x2f) return invalid
        const bits = uint(data, start + 1, 4, true)
        if (bits >>> 29 !== 0) return invalid
        frame = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
      } else {
        if (size <= 10 || data.slice(start + 3, start + 6) !== "\x9d\x01\x2a") return invalid
        const tag = uint(data, start, 3, true)
        if (tag & 1 || ((tag >>> 1) & 7) > 3 || !(tag & 16) || tag >>> 5 > size - 10) return invalid
        const width = uint(data, start + 6, 2, true)
        const height = uint(data, start + 8, 2, true)
        if (width & 0xc000 || height & 0xc000) return "Scaled WebP frames are not supported"
        frame = [width, height]
      }
      const error = dimensions(...frame)
      if (error) return error
    }
    if (type === "ALPH") {
      if (!canvas || alpha !== undefined || frame || size < 2) return invalid
      alpha = data.slice(start, start + size)
      const flags = alpha.charCodeAt(0)
      if (flags & 0xc0 || (flags & 3) > 1 || ((flags >>> 4) & 3) > 1) return invalid
    }
    offset = end
  }
  if (offset !== data.length || !frame) return invalid
  if (canvas && (canvas[0] !== frame[0] || canvas[1] !== frame[1])) return "WebP frame and canvas dimensions must match"
  if (alpha !== undefined && (lossless || (!(alpha.charCodeAt(0) & 3) && alpha.length !== 1 + frame[0] * frame[1])))
    return invalid
  return undefined
}
