import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261101145922_session_last_message",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`last_message\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
