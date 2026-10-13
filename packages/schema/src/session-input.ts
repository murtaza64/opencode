export * as SessionInput from "./session-input"

import { Schema } from "effect"
import { optional } from "./schema"
import { Prompt } from "./prompt"
import { DateTimeUtcFromMillis, NonNegativeInt } from "./schema"
import { SessionDelivery } from "./session-delivery"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"
import { MailSource } from "./session-mail-source"

export const Delivery = SessionDelivery.Delivery
export type Delivery = SessionDelivery.Delivery

export { MailSource }

export interface Admitted extends Schema.Schema.Type<typeof Admitted> {}
export const Admitted = Schema.Struct({
  admittedSeq: NonNegativeInt,
  id: SessionMessage.ID,
  sessionID: SessionID,
  prompt: Prompt,
  delivery: Delivery,
  source: MailSource.pipe(optional),
  timeCreated: DateTimeUtcFromMillis,
  promotedSeq: NonNegativeInt.pipe(optional),
  presentedSeq: NonNegativeInt.pipe(optional),
  timePresented: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "SessionInput.Admitted" })
