import assert from "node:assert/strict"
import { preparePacket } from "./index.mjs"

const [profileFile, profileSHA, parametersFile, parametersSHA, output, ...extra] = process.argv.slice(2)
assert.ok(profileFile && profileSHA && parametersFile && parametersSHA && output && extra.length === 0,
  "usage: bun generate.mjs <profile.json> <sha256> <parameters.json> <sha256> <existing-output-directory>")
console.log(JSON.stringify(await preparePacket({ profile: { file: profileFile, sha256: profileSHA }, parameters: { file: parametersFile, sha256: parametersSHA }, output })))
