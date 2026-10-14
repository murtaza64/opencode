import { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import { Session } from "@/session/session"
import { SessionSupersession } from "@/session/supersession"
import { Effect } from "effect"
import * as ApiError from "../errors"

export function mapStorageNotFound<A, E, R>(self: Effect.Effect<A, StorageNotFoundError | E, R>) {
  return self.pipe(Effect.catchIf(StorageNotFoundError.isInstance, (error) => ApiError.notFound(error.message)))
}

export function mapBusy<A, E, R>(self: Effect.Effect<A, Session.BusyError | E, R>) {
  return self.pipe(Effect.mapError((error) =>
    error instanceof Session.BusyError
      ? new ApiError.SessionBusyError({ sessionID: error.sessionID, message: `Session is busy: ${error.sessionID}` })
      : error,
  ))
}

export const superseded = (error: SessionSupersession.Closed) =>
  new ApiError.SessionSupersededError({
    sessionID: error.sessionID,
    successor: error.successor,
    state: error.state,
    message: `Session is superseded by ${error.successor}`,
  })
