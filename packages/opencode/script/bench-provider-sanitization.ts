import assert from "node:assert/strict"
import { ProviderTransform } from "../src/provider/transform"

// Eight concurrent turns each sanitize their complete model-visible history.
const history = "synthetic history ".repeat(150_000)
const started = performance.now()
for (let turn = 0; turn < 8; turn++) {
  assert.equal(ProviderTransform.sanitizeSurrogates(history), history)
}
const elapsed = performance.now() - started
console.log(JSON.stringify({ turns: 8, historyChars: history.length, elapsedMs: elapsed, budgetMs: 100 }))
assert.ok(elapsed < 100, `History sanitization blocked the event loop for ${elapsed.toFixed(1)}ms`)
