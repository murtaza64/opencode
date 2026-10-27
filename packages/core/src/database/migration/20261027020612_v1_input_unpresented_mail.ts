import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261027020612_v1_input_unpresented_mail",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`v1_session_input_unpresented_mail_idx\` ON \`v1_session_input\` (\`session_id\`) WHERE state = 'promoted' AND json_extract(receipt, '$.timePresented') IS NULL AND json_extract(payload, '$.source.type') = 'editspace-mail';`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
