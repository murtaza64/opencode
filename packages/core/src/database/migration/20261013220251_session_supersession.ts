import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261013220251_session_supersession",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_supersession\` (
          \`session_id\` text PRIMARY KEY,
          \`successor_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`time_committed\` integer,
          CONSTRAINT \`fk_session_supersession_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
