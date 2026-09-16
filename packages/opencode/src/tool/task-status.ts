import { Effect, Schema } from "effect"
import { BackgroundJob } from "@/background/job"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { define } from "./tool"
import type { Context } from "./tool"

const Parameters = Schema.Struct({
  task_id: Schema.String,
  action: Schema.Literals(["inspect", "cancel"]),
})

export const TaskStatusTool = define(
  "task_status",
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const permissions = yield* Permission.Service
    const questions = yield* Question.Service
    return {
      description:
        "Inspect or cancel one of your own task children by task_id. Use on demand, not for polling: background tasks send lifecycle notices. Status is process-local; unknown after restart is not completion. Inspect child history before explicitly resuming with task. This tool cannot answer questions or grant permission.",
      parameters: Parameters,
      execute: Effect.fn("TaskStatusTool.execute")(function* (params: typeof Parameters.Type, ctx: Context) {
        const child = yield* sessions.get(SessionID.make(params.task_id))
        const directory = yield* InstanceState.directory
        if (child.parentID !== ctx.sessionID || child.directory !== directory)
          return yield* Effect.die(new Error("Task must belong to the caller session and directory"))
        yield* ctx.ask({
          permission: "task",
          patterns: [child.agent ?? "general"],
          always: ["*"],
          metadata: { task_id: child.id, action: params.action },
        })
        const job = yield* jobs.get(child.id)
        if (job && (job.type !== "task" || job.metadata?.parentSessionId !== ctx.sessionID))
          return yield* Effect.die(new Error("Task job ownership does not match"))
        const info = params.action === "cancel" && job ? yield* jobs.cancel(child.id) : job
        const pending = [
          ...(yield* permissions.list())
            .filter((request) => request.sessionID === child.id)
            .map((request) => ({ type: "permission", request_id: request.id })),
          ...(yield* questions.list())
            .filter((request) => request.sessionID === child.id)
            .map((request) => ({ type: "question", request_id: request.id })),
        ]
        return {
          title: `Task ${params.action}`,
          metadata: { sessionId: child.id },
          output: JSON.stringify({
            task_id: child.id,
            run_id: info?.run_id,
            status: info?.status === "running" && pending.length ? "waiting" : (info?.status ?? "unknown"),
            pending,
            output: info?.output,
            error: info?.error,
            ...(info
              ? {}
              : {
                  note: "No process-local job record. Restart or instance disposal may have interrupted work. No effects were replayed or cancelled. Inspect child history before explicitly resuming.",
                }),
          }),
        }
      }, Effect.orDie),
    }
  }),
)
