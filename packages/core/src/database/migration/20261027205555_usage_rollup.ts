import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261027205555_usage_rollup",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`usage_hourly\` (
          \`hour\` integer NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`usage_hourly_pk\` PRIMARY KEY(\`hour\`, \`provider_id\`, \`model_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_rollup_state\` (
          \`id\` integer PRIMARY KEY,
          \`cutoff\` integer NOT NULL,
          \`time_backfilled\` integer
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
