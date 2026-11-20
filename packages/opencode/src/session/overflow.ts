import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
  /** An earlier compaction point, in total tokens; the model's limit still applies when lower. */
  threshold?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count = total(input.tokens)
  if (input.threshold !== undefined && count >= input.threshold) return true
  return count >= usable(input)
}

export function total(tokens: SessionV1.Assistant["tokens"]) {
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

/**
 * The total-token point at which an agent's `compaction_threshold` compacts: the first step since the session began
 * or last compacted (its fixed system prompt, summary and kept tail) plus the threshold, so the threshold counts only
 * conversation growth. Counting the whole context would compact again on every turn once the fixed prompt alone
 * exceeds the threshold.
 */
export function agentThreshold(msgs: SessionV1.WithParts[], threshold: number | undefined) {
  if (threshold === undefined) return
  const summary = msgs.findLast((msg) => msg.info.role === "assistant" && msg.info.summary === true)?.info
  const first = msgs
    .map((msg) => msg.info)
    .filter(
      (info): info is SessionV1.Assistant =>
        info.role === "assistant" &&
        info.summary !== true &&
        !!info.finish &&
        total(info.tokens) > 0 &&
        (!summary || info.time.created > summary.time.created),
    )
    .toSorted((a, b) => a.time.created - b.time.created)[0]
  if (!first) return
  return total(first.tokens) + threshold
}
