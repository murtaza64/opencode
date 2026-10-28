import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { InputHandlePayload } from "@opencode-ai/schema/session-v1"

import { Session } from "@/session/session"
import { SessionAside } from "@/session/aside"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionFailure } from "@/session/failure"
import { SessionNudge } from "@/session/nudge"
import { SessionRestart } from "@/session/restart"
import { SessionInput } from "@/session/input"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { Schema, Struct } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import {
  ApiNotFoundError,
  AsideError,
  PermissionNotFoundError,
  SessionBusyError,
  ConflictError,
  InvalidRequestError,
  SessionSupersededError,
} from "../errors"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const root = "/session"
export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scope: Schema.optional(Schema.Literals(["project"])),
  path: Schema.optional(Schema.String),
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})
export const DiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  ...Struct.omit(SessionSummary.DiffInput.fields, ["sessionID"]),
})
export const MessagesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  before: Schema.optional(Schema.String),
  summaryPatches: Schema.optional(QueryBoolean).annotate({
    description: "Include user-summary patch text (default true).",
  }),
  compact: Schema.optional(QueryBoolean).annotate({
    description:
      "Bound tool part sizes for initial page loads (default false): outputs over 8 KB keep their first and last 4 KB, metadata.output previews are dropped, and state.metadata.pageTruncated records the original output length. Fetch the full message with GET /session/:sessionID/message/:messageID.",
  }),
})
export const RestartStatusQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  restartID: SessionRestart.RestartID,
  anchorMessageID: MessageID,
})
export const StatusMap = Schema.Record(Schema.String, SessionStatus.Info)
export const InputsQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  state: Schema.optional(Schema.Literals(["pending", "promoted", "presented", "handled", "cancelled", "all"])),
  after: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 1000 })),
  ),
})
export class InputUpdateConflictError extends Schema.TaggedErrorClass<InputUpdateConflictError>()(
  "InputUpdateConflict",
  { message: Schema.String, current: SessionV1.InputReceipt },
  { httpApiStatus: 409 },
) {}
export const UpdatePayload = Schema.Struct({
  model: Schema.optional(Schema.Struct({ providerID: ProviderV2.ID, modelID: ModelV2.ID, variant: Schema.optional(Schema.String) })),
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Session.Metadata),
  permission: Schema.optional(PermissionV1.Ruleset),
  time: Schema.optional(
    Schema.Struct({
      // null restores an archived Session.
      archived: Schema.optional(Schema.NullOr(Session.ArchivedTimestamp)),
    }),
  ),
})
export const ForkPayload = Schema.Struct(Struct.omit(Session.ForkInput.fields, ["sessionID"]))
export const InitPayload = Schema.Struct({
  modelID: ModelV2.ID,
  providerID: ProviderV2.ID,
  messageID: MessageID,
})
export const SummarizePayload = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  auto: Schema.optional(Schema.Boolean),
})
export const PromptPayload = Schema.Struct(Struct.omit(SessionPrompt.PromptInput.fields, ["sessionID"]))
export const CommandPayload = Schema.Struct(Struct.omit(SessionPrompt.CommandInput.fields, ["sessionID"]))
export const ShellPayload = Schema.Struct(Struct.omit(SessionPrompt.ShellInput.fields, ["sessionID"]))
export const SupersedePayload = Schema.Struct({
  successor: SessionID,
  // An outside-anchored owner handoff names a successor in another directory explicitly.
  scope: Schema.optional(Schema.Literals(["same-directory", "cross-directory"])),
})
export const SupersedeReceipt = Schema.Struct({
  sessionID: SessionID,
  successor: SessionID,
  state: Schema.Literals(["pending", "committed"]),
})
export const RevertPayload = Schema.Struct(Struct.omit(SessionRevert.RevertInput.fields, ["sessionID"]))
export const PermissionResponsePayload = Schema.Struct({
  response: PermissionV1.Reply,
})

export const SessionPaths = {
  list: root,
  status: `${root}/status`,
  get: `${root}/:sessionID`,
  children: `${root}/:sessionID/children`,
  todo: `${root}/:sessionID/todo`,
  diff: `${root}/:sessionID/diff`,
  messages: `${root}/:sessionID/message`,
  message: `${root}/:sessionID/message/:messageID`,
  create: root,
  remove: `${root}/:sessionID`,
  update: `${root}/:sessionID`,
  fork: `${root}/:sessionID/fork`,
  abort: `${root}/:sessionID/abort`,
  retry: `${root}/:sessionID/retry`,
  nudge: `${root}/:sessionID/nudge`,
  restart: `${root}/:sessionID/restart`,
  recover: `${root}/:sessionID/recover`,
  supersede: `${root}/:sessionID/supersede`,
  aside: `${root}/:sessionID/aside`,
  cancelAside: `${root}/:sessionID/aside/:requestID`,
  handleInput: `${root}/:sessionID/input/:requestID/handle`,
  deliverInput: `${root}/:sessionID/input/:requestID/deliver`,
  updateInput: `${root}/:sessionID/input/:requestID`,
  share: `${root}/:sessionID/share`,
  init: `${root}/:sessionID/init`,
  summarize: `${root}/:sessionID/summarize`,
  prompt: `${root}/:sessionID/message`,
  promptAsync: `${root}/:sessionID/prompt_async`,
  command: `${root}/:sessionID/command`,
  shell: `${root}/:sessionID/shell`,
  revert: `${root}/:sessionID/revert`,
  unrevert: `${root}/:sessionID/unrevert`,
  permissions: `${root}/:sessionID/permissions/:permissionID`,
  deleteMessage: `${root}/:sessionID/message/:messageID`,
  deletePart: `${root}/:sessionID/message/:messageID/part/:partID`,
  updatePart: `${root}/:sessionID/message/:messageID/part/:partID`,
} as const

const DeliverInputResult = Schema.Struct({
  outcome: Schema.Literals(["delivered", "settled", "joined", "not-steer", "undeliverable", "superseded"]),
  receipt: SessionV1.InputReceipt,
}).annotate({ identifier: "SessionInputDeliverResult" })

export const SessionApi = HttpApi.make("session")
  .add(
    HttpApiGroup.make("session")
      .add(
        HttpApiEndpoint.post("admitInput", `${root}/:sessionID/input`, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SessionInput.InputPayload,
          success: SessionV1.InputReceipt,
          error: [ApiNotFoundError, ConflictError, InvalidRequestError, SessionSupersededError, HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "session.input.admit", summary: "Admit durable session input" }),
        ),
        HttpApiEndpoint.get("listInputs", `${root}/:sessionID/input`, {
          params: { sessionID: SessionID },
          query: InputsQuery,
          success: Schema.Struct({ items: Schema.Array(SessionV1.InputReceipt), next: Schema.NullOr(Schema.Number) }),
          error: [ApiNotFoundError, InvalidRequestError, HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "session.input.list", summary: "List session input receipts" }),
        ),
        HttpApiEndpoint.get("getInput", `${root}/:sessionID/input/:requestID`, {
          params: { sessionID: SessionID, requestID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: SessionV1.InputReceipt,
          error: [ApiNotFoundError, InvalidRequestError, HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "session.input.get", summary: "Get session input receipt" }),
        ),
        HttpApiEndpoint.patch("updateInput", SessionPaths.updateInput, {
          params: { sessionID: SessionID, requestID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: SessionInput.InputUpdatePayload,
          success: SessionV1.InputReceipt,
          error: [ApiNotFoundError, InputUpdateConflictError, InvalidRequestError, HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "session.input.update", summary: "Update pending human session input" }),
        ),
        HttpApiEndpoint.delete("cancelInput", `${root}/:sessionID/input/:requestID`, {
          params: { sessionID: SessionID, requestID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: SessionV1.InputReceipt,
          error: [ApiNotFoundError, ConflictError, InvalidRequestError, HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "session.input.cancel", summary: "Cancel pending session input" }),
        ),
        HttpApiEndpoint.post("deliverInput", SessionPaths.deliverInput, {
          params: { sessionID: SessionID, requestID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: DeliverInputResult,
          error: [ApiNotFoundError, HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.input.deliver",
            summary: "Interrupt the running turn and deliver pending steers",
            description:
              "Stops the running turn the way abort does (the running tool is killed and recorded as interrupted with its partial output; background subagents keep running), then promotes every pending steer and starts the next turn with them. Nothing is replayed and no prompt is added. Also delivers steers left pending after an earlier abort. A receipt that is no longer pending interrupts nothing (`settled`), so a repeated request is safe; `joined` means another delivery or prompt already owns the session.",
          }),
        ),
        HttpApiEndpoint.post("handleInput", SessionPaths.handleInput, {
          params: { sessionID: SessionID, requestID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: InputHandlePayload,
          success: SessionV1.InputReceipt,
          error: [ApiNotFoundError, ConflictError, HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "session.input.handle", summary: "Record explicit mail handling" }),
        ),
        HttpApiEndpoint.get("list", SessionPaths.list, {
          query: ListQuery,
          success: described(Schema.Array(Session.Info), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.list",
            summary: "List sessions",
            description: "Get a list of all OpenCode sessions, sorted by most recently updated.",
          }),
        ),
        HttpApiEndpoint.get("status", SessionPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(StatusMap, "Get session status"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.status",
            summary: "Get session status",
            description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
          }),
        ),
        HttpApiEndpoint.get("get", SessionPaths.get, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Get session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.get",
            summary: "Get session",
            description: "Retrieve detailed information about a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.get("children", SessionPaths.children, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Session.Info), "List of children"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.children",
            summary: "Get session children",
            description: "Retrieve all child sessions that were forked from the specified parent session.",
          }),
        ),
        HttpApiEndpoint.get("todo", SessionPaths.todo, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Todo.Info), "Todo list"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.todo",
            summary: "Get session todos",
            description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
          }),
        ),
        HttpApiEndpoint.get("diff", SessionPaths.diff, {
          params: { sessionID: SessionID },
          query: DiffQuery,
          success: described(Schema.Array(Snapshot.FileDiff), "Successfully retrieved diff"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.diff",
            summary: "Get message diff",
            description: "Get the file changes (diff) that resulted from a specific user message in the session.",
          }),
        ),
        HttpApiEndpoint.get("messages", SessionPaths.messages, {
          params: { sessionID: SessionID },
          query: MessagesQuery,
          success: described(Schema.Array(SessionV1.WithParts), "List of messages"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.messages",
            summary: "Get session messages",
            description: "Retrieve all messages in a session, including user prompts and AI responses.",
          }),
        ),
        HttpApiEndpoint.get("message", SessionPaths.message, {
          params: { sessionID: SessionID, messageID: MessageID },
          query: WorkspaceRoutingQuery,
          success: described(SessionV1.WithParts, "Message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.message",
            summary: "Get message",
            description: "Retrieve a specific message from a session by its message ID.",
          }),
        ),
        HttpApiEndpoint.post("create", SessionPaths.create, {
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Session.CreateInput],
          success: described(Session.Info, "Successfully created session"),
          error: [HttpApiError.BadRequest, ConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.create",
            summary: "Create session",
            description: "Create a new OpenCode session for interacting with AI assistants and managing conversations.",
          }),
        ),
        HttpApiEndpoint.delete("remove", SessionPaths.remove, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.delete",
            summary: "Delete session",
            description: "Delete a session and permanently remove all associated data, including messages and history.",
          }),
        ),
        HttpApiEndpoint.patch("update", SessionPaths.update, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: UpdatePayload,
          success: described(Session.Info, "Successfully updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.update",
            summary: "Update session",
            description: "Update properties of an existing session, such as title or other metadata.",
          }),
        ),
        HttpApiEndpoint.post("fork", SessionPaths.fork, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, ForkPayload],
          success: described(Session.Info, "200"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.fork",
            summary: "Fork session",
            description: "Create a new session by forking an existing session at a specific message point.",
          }),
        ),
        HttpApiEndpoint.post("aside", SessionPaths.aside, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SessionAside.Input,
          success: described(SessionAside.Result, "Ephemeral snapshot answer"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, AsideError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.aside",
            summary: "Ask an Aside",
            description:
              "Answer a tool-free question from a frozen session snapshot without modifying the session. Results are not stored; only simultaneous duplicate IDs are rejected. Cancelled IDs are blocked for 60 seconds. Use a fresh request ID for a new attempt.",
          }),
        ),
        HttpApiEndpoint.delete("cancelAside", SessionPaths.cancelAside, {
          params: { sessionID: SessionID, requestID: SessionAside.RequestID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Whether an active Aside was found"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, AsideError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.cancelAside",
            summary: "Cancel an Aside",
            description:
              "Cancel only this ephemeral Aside. Returns true if active, false otherwise. Both outcomes block this session/request ID for 60 seconds, including cancellation before the ask arrives. Records are instance-local, bounded, and lost on restart or instance disposal.",
          }),
        ),
        HttpApiEndpoint.post("abort", SessionPaths.abort, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Aborted session"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.abort",
            summary: "Abort session",
            description: "Abort an active session and stop any ongoing AI processing or command execution.",
          }),
        ),
        HttpApiEndpoint.post("retry", SessionPaths.retry, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SessionFailure.RetryPayload,
          success: described(SessionFailure.RetryResult, "Retry decision"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.retry",
            summary: "Retry a failed turn",
            description:
              "Continue a root session whose newest message is the given failed assistant step, without adding a user message. Starts only while the session is idle and that step is still newest; otherwise reports why it did not start. Steps that ran tools are never retried.",
          }),
        ),
        HttpApiEndpoint.post("nudge", SessionPaths.nudge, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SessionNudge.Payload,
          success: described(SessionNudge.Result, "Nudge decision"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.nudge",
            summary: "Continue an idle session on an explicit Nudge",
            description:
              "Explicit UI control for an idle root session whose newest message is still `observedMessageID`. A tail ending in tool results whose effects are durable resumes with no message added. A naturally finished turn continues through one sourced Nudge input (`editspace-mail`, kind `nudge`, text `Continue.`), settled once presented. Refused without writing: `busy`, `waiting` (permission or question), `pending-input` (with `requestIDs`; nothing is promoted or re-routed), `failed` (use retry), `uncertain` (a pending, running, interrupted or abandoned tool, an aborted or unfinished step; use recover), `unanswered`, `stale` (re-read the tail), `child`, `archived`, `superseded`, `mismatch`. Each requestID records its first decision, refusals included: the same body always returns it, and the same requestID with a different body answers 409. Send a new requestID for a new attempt. A Nudge input promoted by any path reports `started`. Interrupted tools are never re-run.",
          }),
        ),
        HttpApiEndpoint.post("restartContinue", SessionPaths.restart, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SessionRestart.ContinuePayload,
          success: described(SessionRestart.ContinueResult, "Restart continuation decision"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.restart.continue",
            summary: "Continue work interrupted by a daemon restart",
            description:
              "Idempotently continue a root session whose newest message is still the anchor captured before a controlled restart, without adding a user message. It resumes only when every effect on the anchor is durable. An anchor with a pending, running or cancelled tool call, an abort that predates the restart, or a future timestamp is marked `uncertain`, left otherwise untouched and not resumed. Failed turns (use retry), finished and advanced sessions are reported without starting. Each decision is recorded as a model-hidden marker on the anchor, so repeating the same restartID reports `duplicate`. Markers are never dropped: an anchor holding the maximum refuses new restart IDs with `capacity`.",
          }),
        ),
        HttpApiEndpoint.get("restartStatus", SessionPaths.restart, {
          params: { sessionID: SessionID },
          query: RestartStatusQuery,
          success: described(SessionRestart.Status, "Recorded restart continuation"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.restart.status",
            summary: "Read a restart continuation record",
            description:
              "Read-only reconciliation for a restart continuation whose acknowledgment was lost: returns the marker recorded for restartID on the anchor, if any, and whether newer messages exist.",
          }),
        ),
        HttpApiEndpoint.post("recover", SessionPaths.recover, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SessionRestart.RecoverPayload,
          success: described(SessionRestart.RecoverResult, "Operator recovery decision"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.recover",
            summary: "Recover a step left with unknown tool effects",
            description:
              "Operator-reviewed recovery of a root session whose newest message is still the given unfinished or aborted assistant step (empty steps opened during shutdown aside). Pending or running tool calls on that step are recorded as abandoned errors stating their effect is unknown and was not repeated; the step is closed as aborted; the typed `text` is admitted as sourced input (kind `recovery`) and the session runs. Nothing is replayed and no output is fabricated. Idempotent per recoveryID via a model-hidden marker on the anchor (`duplicate`). Advanced, finished, failed (use retry) and non-interrupted sessions are reported without writing.",
          }),
        ),
        HttpApiEndpoint.post("supersede", SessionPaths.supersede, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SupersedePayload,
          success: SupersedeReceipt,
          error: [HttpApiError.BadRequest, ApiNotFoundError, InvalidRequestError, SessionSupersededError],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "session.supersede", summary: "Fence a legacy session at its idle boundary" }),
        ),
        HttpApiEndpoint.delete("cancelSupersede", SessionPaths.supersede, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: SupersedeReceipt,
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionSupersededError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.cancelSupersede",
            summary: "Cancel a pending supersession fence",
            description:
              "Reopen a session whose handoff was abandoned before its fence committed. Returns the cancelled pending receipt; a committed fence is final and answers 409.",
          }),
        ),
        HttpApiEndpoint.post("init", SessionPaths.init, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: InitPayload,
          success: described(Schema.Boolean, "200"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionSupersededError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.init",
            summary: "Initialize session",
            description:
              "Analyze the current application and create an AGENTS.md file with project-specific agent configurations.",
          }),
        ),
        HttpApiEndpoint.post("share", SessionPaths.share, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Successfully shared session"),
          error: [HttpApiError.InternalServerError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.share",
            summary: "Share session",
            description: "Create a shareable link for a session, allowing others to view the conversation.",
          }),
        ),
        HttpApiEndpoint.delete("unshare", SessionPaths.share, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Successfully unshared session"),
          error: [HttpApiError.InternalServerError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unshare",
            summary: "Unshare session",
            description: "Remove the shareable link for a session, making it private again.",
          }),
        ),
        HttpApiEndpoint.post("summarize", SessionPaths.summarize, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SummarizePayload,
          success: described(Schema.Boolean, "Summarized session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionSupersededError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.summarize",
            summary: "Summarize session",
            description: "Generate a concise summary of the session using AI compaction to preserve key information.",
          }),
        ),
        HttpApiEndpoint.post("prompt", SessionPaths.prompt, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPayload,
          success: described(SessionV1.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionSupersededError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt",
            summary: "Send message",
            description: "Create and send a new message to a session, streaming the AI response.",
          }),
        ),
        HttpApiEndpoint.post("promptAsync", SessionPaths.promptAsync, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPayload,
          success: described(HttpApiSchema.NoContent, "Prompt accepted"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionSupersededError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt_async",
            summary: "Send async message",
            description:
              "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
          }),
        ),
        HttpApiEndpoint.post("command", SessionPaths.command, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: CommandPayload,
          success: described(SessionV1.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionSupersededError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.command",
            summary: "Send command",
            description: "Send a new command to a session for execution by the AI assistant.",
          }),
        ),
        HttpApiEndpoint.post("shell", SessionPaths.shell, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ShellPayload,
          success: described(SessionV1.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError, SessionSupersededError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.shell",
            summary: "Run shell command",
            description: "Execute a shell command within the session context and return the AI's response.",
          }),
        ),
        HttpApiEndpoint.post("revert", SessionPaths.revert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: RevertPayload,
          success: described(Session.Info, "Updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.revert",
            summary: "Revert message",
            description:
              "Revert a specific message in a session, undoing its effects and restoring the previous state.",
          }),
        ),
        HttpApiEndpoint.post("unrevert", SessionPaths.unrevert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unrevert",
            summary: "Restore reverted messages",
            description: "Restore all previously reverted messages in a session.",
          }),
        ),
        HttpApiEndpoint.post("permissionRespond", SessionPaths.permissions, {
          params: { sessionID: SessionID, permissionID: PermissionV1.ID },
          query: WorkspaceRoutingQuery,
          payload: PermissionResponsePayload,
          success: described(Schema.Boolean, "Permission processed successfully"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, PermissionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.respond",
            summary: "Respond to permission",
            description: "Approve or deny a permission request from the AI assistant.",
            deprecated: true,
          }),
        ),
        HttpApiEndpoint.delete("deleteMessage", SessionPaths.deleteMessage, {
          params: { sessionID: SessionID, messageID: MessageID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.deleteMessage",
            summary: "Delete message",
            description:
              "Permanently delete a specific message and all of its parts from a session without reverting file changes.",
          }),
        ),
        HttpApiEndpoint.delete("deletePart", SessionPaths.deletePart, {
          params: { sessionID: SessionID, messageID: MessageID, partID: PartID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted part"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "part.delete",
            description: "Delete a part from a message.",
          }),
        ),
        HttpApiEndpoint.patch("updatePart", SessionPaths.updatePart, {
          params: { sessionID: SessionID, messageID: MessageID, partID: PartID },
          query: WorkspaceRoutingQuery,
          payload: SessionV1.Part,
          success: described(SessionV1.Part, "Successfully updated part"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "part.update",
            description: "Update a part in a message.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "session",
          description: "Experimental HttpApi session routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
