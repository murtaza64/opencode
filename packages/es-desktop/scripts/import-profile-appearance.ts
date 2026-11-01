/* Import one producer snapshot into a profile's private appearance cache (A0; contracts/work-hosts-and-pins.md §5a).
 * Usage: bun scripts/import-profile-appearance.ts --profile personal --from <snapshot dir> [--to <cache dir>]
 * Prints one JSON receipt; exits 0 for imported/unchanged and 1 for refused (the last good cache is untouched). */
import { homedir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { importProfileAppearance } from "../src/profile-appearance-import"

const args = parseArgs({ options: { profile: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, strict: true }).values
if (args.profile !== "personal" || !args.from) {
  console.error("usage: import-profile-appearance --profile personal --from <snapshot dir> [--to <cache dir>]")
  process.exit(2)
}
const to = args.to ?? process.env.ES_PERSONAL_APPEARANCE_DIR ?? path.join(homedir(), ".local/share/es-profile-appearance/personal")
const receipt = await importProfileAppearance({ profile: args.profile, from: path.resolve(args.from), to })
console.log(JSON.stringify(receipt))
process.exit(receipt.state === "refused" ? 1 : 0)
