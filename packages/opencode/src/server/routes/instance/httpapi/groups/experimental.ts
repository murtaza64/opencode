import { AccountID, OrgID } from "@/account/schema"
import { MCP } from "@/mcp"

import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionFailure } from "@/session/failure"
import { Worktree } from "@/worktree"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const ConsoleStateResponse = Schema.Struct({
  consoleManagedProviders: Schema.mutable(Schema.Array(Schema.String)),
  activeOrgName: Schema.optionalKey(Schema.String),
  switchableOrgCount: NonNegativeInt,
}).annotate({ identifier: "ConsoleState" })

const CapabilitiesResponse = Schema.Struct({
  backgroundSubagents: Schema.Boolean,
  sessionAside: Schema.Struct({
    version: Schema.Literal(1),
    cancel: Schema.Literal(true),
    images: Schema.optionalKey(SessionV1.ImageCapabilities),
  }),
  sessionInput: Schema.Struct({
    version: Schema.Literal(1),
    delivery: Schema.Array(Schema.Literals(["queue", "steer"])),
    list: Schema.Literal(true),
    cancel: Schema.Literal(true),
    update: Schema.Literal(true),
    /** `POST /session/:id/input/:requestID/deliver` interrupts the running turn to deliver steers. */
    interrupt: Schema.Literal(true),
    images: Schema.optionalKey(SessionV1.ImageCapabilities),
    /** Selected context on `POST /session/:id/input` (`context` items), promoted as synthetic text parts. */
    context: Schema.optionalKey(Schema.Literal(true)),
  }),
  /** `prompt_async` with `noReply` records the message only: no turn starts or continues to answer it, busy or idle. */
  noReplyRecordOnly: Schema.optionalKey(Schema.Literal(true)),
}).annotate({ identifier: "ExperimentalCapabilities" })

const ConsoleOrgOption = Schema.Struct({
  accountID: Schema.String,
  accountEmail: Schema.String,
  accountUrl: Schema.String,
  orgID: Schema.String,
  orgName: Schema.String,
  active: Schema.Boolean,
})

const ConsoleOrgList = Schema.Struct({
  orgs: Schema.Array(ConsoleOrgOption),
})

export const ConsoleSwitchPayload = Schema.Struct({
  accountID: AccountID,
  orgID: OrgID,
})

const ToolIDs = Schema.Array(Schema.String).annotate({ identifier: "ToolIDs" })
const ToolListItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
}).annotate({ identifier: "ToolListItem" })
const ToolList = Schema.Array(ToolListItem).annotate({ identifier: "ToolList" })
export const ToolListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  provider: ProviderV2.ID,
  model: ModelV2.ID,
})

const WorktreeList = Schema.Array(Schema.String)
const WorktreeErrorName = Schema.Union([
  Schema.Literal("WorktreeNotGitError"),
  Schema.Literal("WorktreeNameGenerationFailedError"),
  Schema.Literal("WorktreeCreateFailedError"),
  Schema.Literal("WorktreeStartCommandFailedError"),
  Schema.Literal("WorktreeRemoveFailedError"),
  Schema.Literal("WorktreeResetFailedError"),
  Schema.Literal("WorktreeListFailedError"),
])
export class WorktreeApiError extends Schema.ErrorClass<WorktreeApiError>("WorktreeError")(
  {
    name: WorktreeErrorName,
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}
export const SessionListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  archived: Schema.optional(QueryBoolean),
})

const UsageTokens = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
})
export const UsageDailyQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  days: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 90 }))),
  offsetMinutes: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: -840, maximum: 840 })),
  ),
})
const RateLimit = Schema.Struct({
  limit: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
  reset: Schema.optional(Schema.String),
})
export const UsageDailyResponse = Schema.Struct({
  estimate: Schema.Literal(true),
  basis: Schema.String,
  host: Schema.String,
  observedAt: Schema.String,
  offsetMinutes: Schema.Number,
  coverage: Schema.Struct({
    scope: Schema.String,
    liveSince: Schema.optional(Schema.String),
    backfilled: Schema.Boolean,
    origin: Schema.Struct({ basis: Schema.String, hostID: Schema.String, originSince: Schema.optional(Schema.String) }),
  }),
  notes: Schema.Array(Schema.String),
  priceSource: Schema.Struct({
    label: Schema.String,
    managedConfig: Schema.Array(Schema.Struct({ path: Schema.String, modified: Schema.String })),
  }),
  days: Schema.Array(
    Schema.Struct({
      day: Schema.String,
      complete: Schema.Boolean,
      cost: Schema.NullOr(Schema.Number),
      originOnly: Schema.Boolean,
      originCost: Schema.NullOr(Schema.Number),
      unpricedModels: Schema.Number,
      unpricedTokens: Schema.Number,
      models: Schema.Array(
        Schema.Struct({
          provider: Schema.String,
          model: Schema.String,
          cost: Schema.NullOr(Schema.Number),
          coverage: Schema.Literals(["priced", "missing-rate", "local", "no-usage"]),
          tokens: UsageTokens,
        }),
      ),
    }),
  ),
  rateLimits: Schema.Struct({
    source: Schema.String,
    providers: Schema.Array(
      Schema.Struct({
        provider: Schema.String,
        observedAt: Schema.String,
        headers: Schema.Record(Schema.String, Schema.String),
        requests: Schema.optional(RateLimit),
        tokens: Schema.optional(RateLimit),
        inputTokens: Schema.optional(RateLimit),
        outputTokens: Schema.optional(RateLimit),
      }),
    ),
  }),
}).annotate({ identifier: "UsageDaily" })

export const UsageSessionsQuery = Schema.Struct({
  ...UsageDailyQuery.fields,
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 }))),
})
export const UsageSessionsResponse = Schema.Struct({
  estimate: Schema.Literal(true),
  basis: Schema.String,
  host: Schema.String,
  observedAt: Schema.String,
  offsetMinutes: Schema.Number,
  coverage: Schema.Struct({ since: Schema.String, backfilled: Schema.Boolean, liveSince: Schema.optional(Schema.String) }),
  totals: Schema.Struct({ sessions: Schema.Number, pricedCost: Schema.Number, unpricedTokens: Schema.Number }),
  sessions: Schema.Array(
    Schema.Struct({
      sessionID: Schema.String,
      parentID: Schema.optional(Schema.String),
      projectID: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
      directory: Schema.optional(Schema.String),
      cost: Schema.NullOr(Schema.Number),
      pricedCost: Schema.Number,
      unpricedTokens: Schema.Number,
      tokens: UsageTokens,
      lastActive: Schema.String,
    }),
  ),
}).annotate({ identifier: "UsageSessions" })

export const ExperimentalPaths = {
  usageDaily: "/experimental/usage/daily",
  usageSessions: "/experimental/usage/sessions",
  capabilities: "/experimental/capabilities",
  console: "/experimental/console",
  consoleOrgs: "/experimental/console/orgs",
  consoleSwitch: "/experimental/console/switch",
  tool: "/experimental/tool",
  toolIDs: "/experimental/tool/ids",
  worktree: "/experimental/worktree",
  worktreeReset: "/experimental/worktree/reset",
  session: "/experimental/session",
  sessionFailed: "/experimental/session/failed",
  sessionBackground: "/experimental/session/:sessionID/background",
  resource: "/experimental/resource",
} as const

export const ExperimentalApi = HttpApi.make("experimental")
  .add(
    HttpApiGroup.make("experimental")
      .add(
        HttpApiEndpoint.get("capabilities", ExperimentalPaths.capabilities, {
          query: WorkspaceRoutingQuery,
          success: described(CapabilitiesResponse, "Experimental capabilities"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.capabilities.get",
            summary: "Get experimental capabilities",
            description: "Get experimental features enabled on the OpenCode server.",
          }),
        ),
        HttpApiEndpoint.get("usageDaily", ExperimentalPaths.usageDaily, {
          query: UsageDailyQuery,
          success: described(UsageDailyResponse, "Estimated spend per local day"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.usage.daily",
            summary: "Get estimated daily spend",
            description:
              "Estimated model spend on this host per local day (default 7 days including today; offsetMinutes = local offset from UTC, default the server's). Token counts priced by the local model catalog, not provider billing. Only messages that ran on this host count. rateLimits: latest provider-reported rate-limit response headers per provider (memory only).",
          }),
        ),
        HttpApiEndpoint.get("usageSessions", ExperimentalPaths.usageSessions, {
          query: UsageSessionsQuery,
          success: described(UsageSessionsResponse, "Sessions by estimated spend"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.usage.sessions",
            summary: "Get top sessions by estimated spend",
            description:
              "Sessions on this host ranked by estimated spend over the last N local days (default 1; limit default 20, max 200). cost is null when the session used a billed model with no known rate (pricedCost and unpricedTokens give the parts). Local estimate, not provider billing; same origin rules as /experimental/usage/daily.",
          }),
        ),
        HttpApiEndpoint.get("console", ExperimentalPaths.console, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleStateResponse, "Active Console provider metadata"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.get",
            summary: "Get active Console provider metadata",
            description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
          }),
        ),
        HttpApiEndpoint.get("consoleOrgs", ExperimentalPaths.consoleOrgs, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleOrgList, "Switchable Console orgs"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.listOrgs",
            summary: "List switchable Console orgs",
            description: "Get the available Console orgs across logged-in accounts, including the current active org.",
          }),
        ),
        HttpApiEndpoint.post("consoleSwitch", ExperimentalPaths.consoleSwitch, {
          query: WorkspaceRoutingQuery,
          payload: ConsoleSwitchPayload,
          success: described(Schema.Boolean, "Switch success"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.switchOrg",
            summary: "Switch active Console org",
            description: "Persist a new active Console account/org selection for the current local OpenCode state.",
          }),
        ),
        HttpApiEndpoint.get("tool", ExperimentalPaths.tool, {
          query: ToolListQuery,
          success: described(ToolList, "Tools"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.list",
            summary: "List tools",
            description:
              "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
          }),
        ),
        HttpApiEndpoint.get("toolIDs", ExperimentalPaths.toolIDs, {
          query: WorkspaceRoutingQuery,
          success: described(ToolIDs, "Tool IDs"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.ids",
            summary: "List tool IDs",
            description:
              "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
          }),
        ),
        HttpApiEndpoint.get("worktree", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeList, "List of worktree directories"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.list",
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCreate", ExperimentalPaths.worktree, {
          disableCodecs: true,
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Worktree.CreateInput],
          success: described(Worktree.Info, "Worktree created"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.create",
            summary: "Create worktree",
            description: "Create a new git worktree for the current project and run any configured startup scripts.",
          }),
        ),
        HttpApiEndpoint.delete("worktreeRemove", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.RemoveInput,
          success: described(Schema.Boolean, "Worktree removed"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.remove",
            summary: "Remove worktree",
            description: "Remove a git worktree and delete its branch.",
          }),
        ),
        HttpApiEndpoint.post("worktreeReset", ExperimentalPaths.worktreeReset, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.ResetInput,
          success: described(Schema.Boolean, "Worktree reset"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.reset",
            summary: "Reset worktree",
            description: "Reset a worktree branch to the primary default branch.",
          }),
        ),
        HttpApiEndpoint.get("session", ExperimentalPaths.session, {
          query: SessionListQuery,
          success: described(Schema.Array(Session.GlobalInfo), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.list",
            summary: "List sessions",
            description:
              "Get a list of all OpenCode sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
          }),
        ),
        HttpApiEndpoint.get("sessionFailed", ExperimentalPaths.sessionFailed, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(SessionFailure.Info), "Failed sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.failed",
            summary: "List failed sessions",
            description:
              "List unarchived root sessions across projects whose newest message is an assistant step that ended in a non-abort error, without a handoff fence. Returns error names and status codes only.",
          }),
        ),
        HttpApiEndpoint.post("sessionBackground", ExperimentalPaths.sessionBackground, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Backgrounded subagents"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.background",
            summary: "Background subagents",
            description:
              "Detach any synchronous subagents currently blocking the session and continue them in the background.",
          }),
        ),
        HttpApiEndpoint.get("resource", ExperimentalPaths.resource, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Resource), "MCP resources"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.resource.list",
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "experimental",
          description: "Experimental HttpApi read-only routes.",
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
