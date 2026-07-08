// fork(session-umbrella): umbrella listing handler.
import { Effect } from "effect"
import { and, desc, eq, isNull, like, or, sql } from "drizzle-orm"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { InstanceState } from "@/effect/instance-state"
import { fromRow } from "@/session/session"
import { Umbrella } from "@/fork/umbrella"
import { InstanceHttpApi } from "../api"

export const umbrellaHandlers = HttpApiBuilder.group(InstanceHttpApi, "umbrella", (handlers) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const list = Effect.fn("UmbrellaHttpApi.list")(function* () {
      const directory = yield* InstanceState.directory
      const umbrellas = yield* Umbrella.load()
      const umbrella = Umbrella.find(umbrellas, directory)
      if (!umbrella) return []

      const rows = yield* db
        .select()
        .from(SessionTable)
        .where(
          and(
            or(
              eq(SessionTable.directory, umbrella.root),
              like(SessionTable.directory, sql.param(`${umbrella.root}/%`, SessionTable.directory)),
            ),
            isNull(SessionTable.time_archived),
          ),
        )
        .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
        .all()
        .pipe(Effect.orDie)

      return rows.flatMap((row) => {
        const member = Umbrella.memberFor(umbrella, row.directory)
        if (!member) return []
        return [{ ...fromRow(row), umbrella: umbrella.name, member }]
      })
    })

    return handlers.handle("list", list)
  }),
)
