import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028064500_usage_rollup_session",
  up(tx) {
    return Effect.gen(function* () {
      // The rollup gains a session key. Its rows are derived data, so rebuild them: drop the table, move the
      // cutoff to now and clear the backfill mark so the one-time backfill recounts all history per session.
      yield* tx.run("DROP TABLE `usage_hourly`;")
      yield* tx.run(`
        CREATE TABLE \`usage_hourly\` (
          \`hour\` integer NOT NULL,
          \`session_id\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`usage_hourly_pk\` PRIMARY KEY(\`hour\`, \`session_id\`, \`provider_id\`, \`model_id\`)
        );
      `)
      yield* tx.run(
        "UPDATE `usage_rollup_state` SET `cutoff` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), `time_backfilled` = NULL WHERE `id` = 1;",
      )
    })
  },
} satisfies DatabaseMigration.Migration
