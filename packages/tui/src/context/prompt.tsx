import { createSimpleContext } from "./helper"
import type { PromptRef } from "../component/prompt"
import type { ComposerState } from "../component/prompt/delivery"

export const { use: usePromptRef, provider: PromptRefProvider } = createSimpleContext({
  name: "PromptRef",
  init: () => {
    let current: PromptRef | undefined

    return {
      drafts: new Map<string, ComposerState>(),
      get current() {
        return current
      },
      set(ref: PromptRef | undefined) {
        current = ref
      },
    }
  },
})
