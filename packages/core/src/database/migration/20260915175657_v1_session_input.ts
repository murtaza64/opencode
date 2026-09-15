import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260915175657_v1_session_input",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`v1_session_input\` (
          \`request_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`model\` text NOT NULL,
          \`receipt\` text NOT NULL,
          CONSTRAINT \`fk_v1_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`v1_session_input_pending_idx\` ON \`v1_session_input\` (\`session_id\`,\`state\`,\`admitted_seq\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
