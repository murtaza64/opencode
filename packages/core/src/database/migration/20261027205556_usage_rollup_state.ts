import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261027205556_usage_rollup_state",
  // Fresh databases get the generated tables but still need the state row.
  fresh: true,
  up(tx) {
    return Effect.gen(function* () {
      // Messages created from now on are counted live; older ones by the one-time backfill.
      yield* tx.run(
        "INSERT INTO `usage_rollup_state` (`id`, `cutoff`) VALUES (1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT DO NOTHING;",
      )
    })
  },
} satisfies DatabaseMigration.Migration
