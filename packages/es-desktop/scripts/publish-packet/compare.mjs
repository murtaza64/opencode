import assert from "node:assert/strict"
import { compareFrozen } from "./index.mjs"

const [file, sha256, directory, ...extra] = process.argv.slice(2)
assert.ok(file && sha256 && directory && extra.length === 0, "usage: bun compare.mjs <packet-index.json> <sha256> <hand-frozen-directory>")
const result = await compareFrozen({ index: { file, sha256 }, directory })
console.log(JSON.stringify(result))
if (result.result !== "PASS") process.exitCode = 1
