export * as SessionSupersession from "./supersession"

import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionSchema } from "./schema"
import { SessionSupersessionTable } from "./sql"

export class Closed extends Schema.TaggedErrorClass<Closed>()("SessionSuperseded", {
  sessionID: SessionSchema.ID,
  successor: SessionSchema.ID,
  state: Schema.Literals(["pending", "committed"]),
}) {}

export const assertOpen = Effect.fn("SessionSupersession.assertOpen")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ successor: SessionSupersessionTable.successor_id, state: SessionSupersessionTable.state })
    .from(SessionSupersessionTable)
    .where(eq(SessionSupersessionTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (row) return yield* new Closed({ sessionID, ...row })
})
