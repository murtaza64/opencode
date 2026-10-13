export * as SessionMailSource from "./session-mail-source"

import { Schema } from "effect"
import { optional } from "./schema"

export interface MailSource extends Schema.Schema.Type<typeof MailSource> {}
export const MailSource = Schema.Struct({
  type: Schema.Literal("editspace-mail"),
  id: Schema.String,
  sender: Schema.String,
  senderSession: Schema.String.pipe(optional),
  recipient: Schema.String,
  relationship: Schema.String.pipe(optional),
  originRun: Schema.String.pipe(optional),
  kind: Schema.String.pipe(optional),
  in_reply_to: Schema.String.pipe(optional),
  supersedes: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionInput.MailSource" })
