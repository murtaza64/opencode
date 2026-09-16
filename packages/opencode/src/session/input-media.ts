import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { InputImageValidation } from "@opencode-ai/schema/v1/input-image-validation"
import { Image } from "@/image/image"
import { Provider } from "@/provider/provider"
import { MessageID, PartID, SessionID } from "./schema"

export class Invalid extends Schema.TaggedErrorClass<Invalid>()("InputMediaInvalid", { message: Schema.String }) {}

const make = Effect.gen(function* () {
  const image = yield* Image.Service
  const normalize = Effect.fn("SessionInputMedia.normalize")(function* (
    images: readonly SessionV1.InputImage[],
    model: Provider.Model,
  ) {
    if (!images.length) return []
    if (!model.capabilities.input.image)
      return yield* new Invalid({ message: "Selected model does not support image input" })
    const invalid = InputImageValidation.issue(images)
    if (invalid) return yield* new Invalid({ message: invalid })
    const normalized = yield* Effect.forEach(images, (input) =>
      image
        .normalize({
          ...input,
          id: PartID.ascending(),
          messageID: MessageID.ascending(),
          sessionID: SessionID.create(),
        })
        .pipe(
          Effect.mapError(
            () => new Invalid({ message: "Image could not be decoded or normalized within configured limits" }),
          ),
          Effect.flatMap((result) =>
            Schema.decodeUnknownEffect(SessionV1.InputImage)({ ...input, mime: result.mime, url: result.url }),
          ),
          Effect.mapError(
            () => new Invalid({ message: "Image could not be normalized within supported media limits" }),
          ),
        ),
    )
    const error = InputImageValidation.issue(normalized)
    if (error) return yield* new Invalid({ message: error })
    return normalized
  })
  return { normalize }
})

export class Service extends Context.Service<Service, Effect.Success<typeof make>>()("@opencode/SessionInputMedia") {}
export const node = LayerNode.make({ service: Service, layer: Layer.effect(Service, make), deps: [Image.node] })
export * as SessionInputMedia from "./input-media"
