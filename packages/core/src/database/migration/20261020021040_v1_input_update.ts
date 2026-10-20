import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261020021040_v1_input_update",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`v1_session_input_command\` (
          \`command_id\` text PRIMARY KEY,
          \`request_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`command\` text NOT NULL,
          \`receipt\` text NOT NULL,
          CONSTRAINT \`fk_v1_session_input_command_request_id_v1_session_input_request_id_fk\` FOREIGN KEY (\`request_id\`) REFERENCES \`v1_session_input\`(\`request_id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
