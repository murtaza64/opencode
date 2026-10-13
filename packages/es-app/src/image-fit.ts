export type ImageLimits = {
  mimeTypes: readonly string[]
  maxBytes: number
  maxTotalBytes: number
  maxWidth: number
  maxHeight: number
  maxPixels: number
}

export const defaultImageCapability = {
  mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"] as const,
  maxBytes: 5_242_880,
  maxTotalBytes: 10_485_760,
  maxWidth: 8192,
  maxHeight: 8192,
  maxPixels: 16_777_216,
} satisfies ImageLimits

export const fitImage = (
  input: { width: number; height: number; bytes: number; mime: string },
  capability: ImageLimits,
  totalSoFar = 0,
): { action: "keep" } | { action: "encode"; width: number; height: number; attempts: { mime: "image/png" | "image/jpeg"; quality?: number }[] } => {
  if (
    capability.mimeTypes.includes(input.mime) &&
    input.width <= capability.maxWidth &&
    input.height <= capability.maxHeight &&
    input.width * input.height <= capability.maxPixels &&
    input.bytes <= capability.maxBytes &&
    input.bytes + totalSoFar <= capability.maxTotalBytes
  ) return { action: "keep" }

  const scale = Math.min(1, capability.maxWidth / input.width, capability.maxHeight / input.height,
    Math.sqrt(capability.maxPixels / (input.width * input.height)))
  return {
    action: "encode",
    width: Math.max(1, Math.floor(input.width * scale)),
    height: Math.max(1, Math.floor(input.height * scale)),
    attempts: [
      ...(input.mime === "image/jpeg" ? [] : [{ mime: "image/png" as const }]),
      ...([0.92, 0.85, 0.75, 0.6].map((quality) => ({ mime: "image/jpeg" as const, quality }))),
    ],
  }
}

export const prepareImageFile = async (file: File, capability: ImageLimits, totalSoFar: number): Promise<{
  mime: string
  url: string
  filename: string
  normalized: boolean
}> => {
  const filename = file.name || `pasted.${(file.type.split("/")[1] ?? "png").split("+")[0]}`
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
    reader.onerror = () => reject(reader.error ?? new Error("Cannot read image"))
    reader.readAsDataURL(file)
  })
  const bitmap = await (async () => {
    try {
      return await createImageBitmap(file)
    } catch {
      const objectURL = URL.createObjectURL(file)
      try {
        return await new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = () => reject(new Error(`Cannot decode ${file.type || "image"}; paste a PNG or JPEG`))
          image.src = objectURL
        })
      } finally {
        URL.revokeObjectURL(objectURL)
      }
    }
  })()
  try {
    const plan = fitImage({ width: bitmap.width, height: bitmap.height, bytes: file.size, mime: file.type }, capability, totalSoFar)
    if (plan.action === "keep") return { mime: file.type, url: original, filename, normalized: false }
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Cannot prepare image: canvas unavailable")
    const budget = Math.min(capability.maxBytes, capability.maxTotalBytes - totalSoFar)
    if (budget <= 0) throw new Error("Images exceed the total byte limit. Remove an image and try again.")
    let width = plan.width
    let height = plan.height
    while (true) {
      canvas.width = width
      canvas.height = height
      context.drawImage(bitmap, 0, 0, width, height)
      for (const attempt of plan.attempts) {
        if (!capability.mimeTypes.includes(attempt.mime)) continue
        const url = canvas.toDataURL(attempt.mime, attempt.quality)
        if (!url.startsWith(`data:${attempt.mime};base64,`)) continue
        const encoded = url.slice(url.indexOf(",") + 1)
        const bytes = (encoded.length / 4) * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0)
        if (bytes <= budget) return { mime: attempt.mime, url, filename, normalized: true }
      }
      const longest = Math.max(width, height)
      if (longest <= 512) throw new Error("Cannot fit image within the image byte limit. Try a smaller image.")
      const next = Math.max(512, Math.floor(longest * 0.8))
      width = Math.max(1, Math.floor(width * next / longest))
      height = Math.max(1, Math.floor(height * next / longest))
    }
  } finally {
    if (typeof ImageBitmap !== "undefined" && bitmap instanceof ImageBitmap) bitmap.close()
  }
}
