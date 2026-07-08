// fork(session-umbrella): umbrella listing — the merged session universe
// across all members of the requesting directory's umbrella, each session
// tagged with its member. See prds/session-umbrella.md.
import { Session } from "@/session/session"
import { Umbrella } from "@/fork/umbrella"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/umbrella"

export const UmbrellaSession = Schema.Struct({
  ...Session.Info.fields,
  umbrella: Schema.String,
  member: Umbrella.Member,
}).annotate({ identifier: "UmbrellaSession" })

export const UmbrellaApi = HttpApi.make("umbrella")
  .add(
    HttpApiGroup.make("umbrella")
      .add(
        HttpApiEndpoint.get("list", `${root}/session`, {
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.Array(UmbrellaSession),
            "Sessions across all umbrella members, tagged with their member",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "umbrella.session.list",
            summary: "List sessions across the umbrella",
            description:
              "List sessions across every member directory of the umbrella containing the requesting directory. Returns an empty list when the directory belongs to no umbrella.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "umbrella",
          description: "Fork: es-declared logical project grouping.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode fork umbrella api",
      version: "0.0.1",
      description: "Fork: umbrella session listing.",
    }),
  )
