import { expect, test } from "bun:test"
import type { MessageWithParts } from "./api"
import { attachmentsUnder } from "./api"

const route = "/session/ses_a/message/msg_t/part/prt_t/attachment/0"
const tool = (attachments: { mime: string; url: string }[]) => ({
  info: { id: "msg_t", sessionID: "ses_a", role: "assistant" },
  parts: [{ id: "prt_t", type: "tool", tool: "read", sessionID: "ses_a", messageID: "msg_t", callID: "c",
    state: { status: "completed", input: {}, output: "ok", title: "", metadata: {}, time: { start: 1, end: 2 }, attachments } }],
}) as unknown as MessageWithParts

const urls = (message: MessageWithParts) => (message.parts[0] as { state: { attachments: { url: string }[] } }).state.attachments.map((file) => file.url)

test("a compact page's attachment routes resolve under this host's base; other urls pass through", () => {
  const page = [tool([{ mime: "image/png", url: route }, { mime: "image/png", url: "data:image/png;base64,AAAA" }])]
  expect(urls(attachmentsUnder("/oc", page)[0]!)).toEqual([`/oc${route}`, "data:image/png;base64,AAAA"])
  // Another Work host's session: its own host's route through this listener.
  expect(urls(attachmentsUnder("/hosts/mini/oc", page)[0]!)).toEqual([`/hosts/mini/oc${route}`, "data:image/png;base64,AAAA"])
})

test("an older Core's full page (inline data, no routes) is returned as it came", () => {
  const page = [tool([{ mime: "image/png", url: "data:image/png;base64,AAAA" }])]
  expect(attachmentsUnder("/oc", page)[0]).toBe(page[0])
  // A url that only looks like the route is not rewritten.
  expect(urls(attachmentsUnder("/oc", [tool([{ mime: "image/png", url: `${route}/../x` }])])[0]!)).toEqual([`${route}/../x`])
})

const filePart = (url: string, compactFile?: object) => ({
  info: { id: "msg_u", sessionID: "ses_a", role: "user" },
  parts: [{ id: "prt_f", type: "file", sessionID: "ses_a", messageID: "msg_u", mime: "image/png", filename: "shot.png", url,
    ...(compactFile ? { metadata: { compactFile } } : {}) }],
}) as unknown as MessageWithParts
const fileRoute = "/session/ses_a/message/msg_u/part/prt_f/file"
const fileUrl = (message: MessageWithParts) => (message.parts[0] as { url: string }).url

test("a compact page's large file part loads from its own host's part file route", () => {
  const meta = { urlLength: 3_690_000, bytes: 2_760_000, mime: "image/png" }
  expect(fileUrl(attachmentsUnder("/oc", [filePart(fileRoute, meta)])[0]!)).toBe(`/oc${fileRoute}`)
  expect(fileUrl(attachmentsUnder("/hosts/mini/oc", [filePart(fileRoute, meta)])[0]!)).toBe(`/hosts/mini/oc${fileRoute}`)
  // Inline data, a route without compactFile metadata, or a look-alike url pass through unchanged.
  const inline = [filePart("data:image/png;base64,AAAA")]
  expect(attachmentsUnder("/oc", inline)[0]).toBe(inline[0])
  expect(fileUrl(attachmentsUnder("/oc", [filePart(fileRoute)])[0]!)).toBe(fileRoute)
  expect(fileUrl(attachmentsUnder("/oc", [filePart(`${fileRoute}/../x`, meta)])[0]!)).toBe(`${fileRoute}/../x`)
})
