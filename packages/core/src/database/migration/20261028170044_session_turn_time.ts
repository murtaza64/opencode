import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028170044_session_turn_time",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`time_turn_started\` integer;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`time_turn_ended\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
