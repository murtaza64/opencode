import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261013210939_session_input_presentation_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`presented_seq\` integer;`)
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`time_presented\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
