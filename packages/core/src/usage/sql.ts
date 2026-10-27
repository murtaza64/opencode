import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core"

/**
 * Estimated model spend per UTC hour, provider and model, for messages that ran on this host. Hour buckets let
 * readers aggregate by any local day. Maintained by the session projector; see `UsageRollup`.
 */
export const UsageHourlyTable = sqliteTable(
  "usage_hourly",
  {
    hour: integer().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.hour, table.provider_id, table.model_id] })],
)

/**
 * One row. Live projection counts messages created at or after `cutoff`; a one-time backfill counts older
 * assistant messages and records `time_backfilled`.
 */
export const UsageRollupStateTable = sqliteTable("usage_rollup_state", {
  id: integer().primaryKey(),
  cutoff: integer().notNull(),
  time_backfilled: integer(),
})
