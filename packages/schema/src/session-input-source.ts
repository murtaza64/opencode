export * as SessionInputSource from "./session-input-source"

import { Schema } from "effect"
import { optional } from "./schema"

/**
 * Who delivered an input. Absent source or `human` is the interactive user and is
 * the only source that carries user trust; every other source is rendered to the
 * provider with a lower-trust header block.
 */
export interface HumanSource extends Schema.Schema.Type<typeof HumanSource> {}
export const HumanSource = Schema.Struct({
  type: Schema.Literal("human"),
  // Client surface that accepted the input, e.g. "es-app", "tui", "cli".
  via: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionInput.HumanSource" })

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

/** An orchestrating agent or operator tool woke this session (`es agent resume`). */
export interface ResumeSource extends Schema.Schema.Type<typeof ResumeSource> {}
export const ResumeSource = Schema.Struct({
  type: Schema.Literal("resume"),
  sender: Schema.String,
  senderSession: Schema.String.pipe(optional),
  originRun: Schema.String.pipe(optional),
  // Mail id this resume answers; lets the receiver close the question.
  in_reply_to: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionInput.ResumeSource" })

/** Scheduled automation (launchd, cron) with no human or agent behind it. */
export interface HeartbeatSource extends Schema.Schema.Type<typeof HeartbeatSource> {}
export const HeartbeatSource = Schema.Struct({
  type: Schema.Literal("heartbeat"),
  sender: Schema.String,
  schedule: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionInput.HeartbeatSource" })

/** A child session finished and its result is delivered to the parent. */
export interface SubagentReturnSource extends Schema.Schema.Type<typeof SubagentReturnSource> {}
export const SubagentReturnSource = Schema.Struct({
  type: Schema.Literal("subagent-return"),
  sessionID: Schema.String,
  agent: Schema.String.pipe(optional),
  callID: Schema.String.pipe(optional),
  status: Schema.Literals(["completed", "failed", "aborted"]).pipe(optional),
}).annotate({ identifier: "SessionInput.SubagentReturnSource" })

/** A predecessor session handed its lane to this one (`es agent handoff`). */
export interface HandoffSource extends Schema.Schema.Type<typeof HandoffSource> {}
export const HandoffSource = Schema.Struct({
  type: Schema.Literal("handoff"),
  predecessor: Schema.String,
  sender: Schema.String.pipe(optional),
  lane: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionInput.HandoffSource" })

export const InputSource = Schema.Union([
  HumanSource,
  MailSource,
  ResumeSource,
  HeartbeatSource,
  SubagentReturnSource,
  HandoffSource,
]).annotate({ identifier: "SessionInput.Source" })
export type InputSource = typeof InputSource.Type

/** Sources other than the interactive human; the provider sees these with a header block. */
export type AgentSource = Exclude<InputSource, HumanSource>

export const isAgentSource = (source: InputSource | undefined): source is AgentSource =>
  source !== undefined && source.type !== "human"
