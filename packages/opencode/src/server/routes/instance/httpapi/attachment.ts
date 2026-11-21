import { DatabaseReader } from "@opencode-ai/core/database/reader"
import { PartTable } from "@opencode-ai/core/session/sql"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"

// Served types render without running script; anything else downloads as opaque bytes.
const SAFE_TYPES = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf)$/

/**
 * `GET /session/:sessionID/message/:messageID/part/:partID/attachment/:index`: the bytes of one inline (data URL)
 * attachment of a completed tool part; `.../part/:partID/file`: the bytes of a file part's inline data. Compact message
 * pages reference large attachments and files here instead of inlining them. Behind the server's normal authorization; only stored data URLs are served, never remote or file URLs.
 */
export const attachmentRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader.Service
    const lookup = (params: Readonly<Record<string, string | undefined>>) =>
      reader.db
        .select({ data: PartTable.data })
        .from(PartTable)
        .where(
          and(
            eq(PartTable.id, String(params.partID) as never),
            eq(PartTable.session_id, String(params.sessionID) as never),
            eq(PartTable.message_id, String(params.messageID) as never),
          ),
        )
        .get()
        .pipe(
          Effect.orDie,
          Effect.map(
            (row) =>
              row?.data as
                | {
                    type?: string
                    mime?: string
                    url?: string
                    state?: { status?: string; attachments?: { mime?: string; url?: string }[] }
                  }
                | undefined,
          ),
        )
    yield* router.add(
      "GET",
      "/session/:sessionID/message/:messageID/part/:partID/attachment/:index",
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const index = Number(route.params.index)
        if (!Number.isInteger(index) || index < 0) return HttpServerResponse.empty({ status: 404 })
        const data = yield* lookup(route.params)
        return serve(data?.type === "tool" && data.state?.status === "completed" ? data.state.attachments?.[index] : undefined)
      }),
    )
    // A file part's own inline data (pasted or attached images, PDFs): compact message pages reference it here.
    yield* router.add(
      "GET",
      "/session/:sessionID/message/:messageID/part/:partID/file",
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const data = yield* lookup(route.params)
        return serve(data?.type === "file" ? data : undefined)
      }),
    )
  }),
)

function serve(file: { mime?: string; url?: string } | undefined) {
  const match = file?.url ? /^data:([^,;]*)((?:;[^,;]*)*?)(;base64)?,(.*)$/s.exec(file.url) : null
  if (!file || !match) return HttpServerResponse.empty({ status: 404 })
  const bytes = match[3] ? Buffer.from(match[4]!, "base64") : Buffer.from(decodeURIComponent(match[4]!))
  const type = file.mime && SAFE_TYPES.test(file.mime) ? file.mime : "application/octet-stream"
  return HttpServerResponse.uint8Array(new Uint8Array(bytes), {
    contentType: type,
    headers: {
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    },
  })
}
