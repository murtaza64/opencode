/* Read-only Personal activation evidence (src/personal-activation-check.ts). Prints one JSON object.
 * Usage: bun scripts/personal-activation-check.ts pre|post [--user-data <dir>] [--cache <dir>] [--host excalibur]
 *   [--transfer 64b951fe] [--keychain <item>]... [--pre <pre.json>] */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { postCheck, preCheck } from "../src/personal-activation-check"

const parsed = parseArgs({ allowPositionals: true, strict: true, options: {
  "user-data": { type: "string" }, cache: { type: "string" }, host: { type: "string" }, transfer: { type: "string" },
  keychain: { type: "string", multiple: true }, pre: { type: "string" },
} })
const phase = parsed.positionals[0]
if (phase !== "pre" && phase !== "post") {
  console.error("usage: personal-activation-check pre|post [--user-data <dir>] [--cache <dir>] [--host <id>] [--transfer <prefix>] [--keychain <item>]... [--pre <pre.json>]")
  process.exit(2)
}
const values = parsed.values
const options = {
  userData: values["user-data"] ?? path.join(homedir(), "Library/Application Support/Editspace"),
  cache: values.cache ?? process.env.ES_PERSONAL_APPEARANCE_DIR ?? path.join(homedir(), ".local/share/es-profile-appearance/personal"),
  host: values.host ?? "excalibur",
  transfer: values.transfer ?? "64b951fe",
  keychain: values.keychain,
}
const result = phase === "pre" ? await preCheck(options)
  : await postCheck({ ...options, pre: values.pre ? JSON.parse(await readFile(values.pre, "utf8")) : undefined })
console.log(JSON.stringify(result, null, 2))
