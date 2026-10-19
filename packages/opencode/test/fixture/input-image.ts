import { Effect } from "effect"
import { crc32, deflateSync } from "node:zlib"
import { testProviderConfig } from "../lib/test-provider"

export const inputImage = (color = 127) =>
  Effect.gen(function* () {
    const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
    const image = new photon.PhotonImage(new Uint8Array([color, 0, 255, 255]), 1, 1)
    const url = `data:image/png;base64,${Buffer.from(image.get_bytes()).toString("base64")}`
    image.free()
    return { type: "file" as const, mime: "image/png" as const, url, filename: "disposable.png" }
  })

export const pngMetadata = (
  url: string,
  type: "zTXt" | "iTXt" | "iCCP",
  compressed = deflateSync(Buffer.from("synthetic screenshot metadata")),
) => {
  const data = Buffer.concat([Buffer.from(type === "iTXt" ? "fixture\0\x01\0\0\0" : "fixture\0\0"), compressed])
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(type, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  const png = Buffer.from(url.slice(url.indexOf(",") + 1), "base64")
  return `data:image/png;base64,${Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]).toString("base64")}`
}

export const imageProviderConfig = (url: string) => {
  const config = testProviderConfig(url)
  return {
    ...config,
    provider: {
      test: {
        ...config.provider.test,
        models: {
          "text-only": { ...config.provider.test.models["test-model"], id: "text-only" },
          "test-model": {
            ...config.provider.test.models["test-model"],
            attachment: true,
            modalities: { input: ["text", "image"] as ["text", "image"], output: ["text"] as ["text"] },
          },
        },
      },
    },
  }
}
