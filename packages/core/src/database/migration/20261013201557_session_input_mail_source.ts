import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261013201557_session_input_mail_source",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`source\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
