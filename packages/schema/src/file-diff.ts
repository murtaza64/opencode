export * as FileDiff from "./file-diff"

import { Schema } from "effect"
import { optional } from "./schema"

export const Info = Schema.Struct({
  file: optional(Schema.String),
  patch: optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: optional(Schema.Literals(["added", "deleted", "modified"])),
  /**
   * The patch text was left out to bound an inline payload (a message summary); counts and status are still exact.
   * `GET /session/:sessionID/diff?messageID=` returns the full patch.
   */
  patchOmitted: optional(Schema.Literal(true)),
}).annotate({ identifier: "SnapshotFileDiff" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
