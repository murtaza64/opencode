import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028083343_session_nudge",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_nudge\` (
          \`request_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`observed_message_id\` text NOT NULL,
          \`result\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_nudge_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
