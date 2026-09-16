import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260916185726_v1_input_images",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`v1_session_input\` ADD \`images\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
