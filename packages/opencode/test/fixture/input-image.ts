import { Effect } from "effect"
import { testProviderConfig } from "../lib/test-provider"

export const inputImage = (color = 127) =>
  Effect.gen(function* () {
    const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
    const image = new photon.PhotonImage(new Uint8Array([color, 0, 255, 255]), 1, 1)
    const url = `data:image/png;base64,${Buffer.from(image.get_bytes()).toString("base64")}`
    image.free()
    return { type: "file" as const, mime: "image/png" as const, url, filename: "disposable.png" }
  })

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
