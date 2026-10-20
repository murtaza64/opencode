import { describe, expect, test } from "bun:test"
import type { MessageWithParts } from "./api"
import { createFindHistory, findDocuments, FIND_LIMITS, scanDocuments, type FindDocument } from "./transcript-find"

const row = (id: string, text = "hello"): MessageWithParts => ({
  info: { id, sessionID: "ses_test", role: "user", agent: "build", model: { providerID: "test", modelID: "test" }, time: { created: 1 } },
  parts: [{ id: `part_${id}`, sessionID: "ses_test", messageID: id, type: "text", text }],
})
const document = (text: string): FindDocument => ({ messageID: "msg_test", partID: "part_test", role: "user", kind: "user text", text })
const signal = () => new AbortController().signal

describe("transcript Find", () => {
  test("matches metacharacters literally and preserves Unicode source offsets", async () => {
    const result = await scanDocuments([document("😀 Straße [a.*] שלום STRASSE")], "strasse", signal())
    expect(result.hits.map((hit) => [hit.start, hit.end, hit.match])).toEqual([[3, 9, "Straße"], [21, 28, "STRASSE"]])
    expect((await scanDocuments([document("[a.*] aaaa")], "[a.*]", signal())).hits.map((hit) => hit.match)).toEqual(["[a.*]"])
    expect((await scanDocuments([document("ß")], "s", signal())).hits.map((hit) => hit.match)).toEqual(["ß"])
  })
  test("finds a literal split across the scan chunk boundary", async () => {
    const result = await scanDocuments([document("x".repeat(FIND_LIMITS.chunk - 2) + "needle")], "NEEDLE", signal())
    expect(result.hits.map((hit) => hit.start)).toEqual([FIND_LIMITS.chunk - 2])
  })
  test("keeps non-overlapping matches consistent across chunk boundaries", async () => {
    const result = await scanDocuments([document("a".repeat(32_790))], "aaa", signal(), 20_000)
    expect(result.hits).toHaveLength(10_930)
    expect(result.hits[10_923]?.start).toBe(32_769)
  })
  test("keeps surrogate pairs intact at excerpt edges", async () => {
    const result = await scanDocuments([document("😀".repeat(51) + "needle" + "a".repeat(159) + "😀")], "needle", signal())
    expect(result.hits[0]?.before).toBe("😀".repeat(50))
    expect(result.hits[0]?.after).toBe("a".repeat(159) + "😀")
  })
  test("indexes prose and tool results but excludes hidden/generated/internal content", () => {
    const item = row("msg_1")
    expect(findDocuments(item.info, [
      ...item.parts,
      { sessionID: "ses_test", messageID: "msg_1", type: "text", id: "ignored", text: "ignored", ignored: true },
      { sessionID: "ses_test", messageID: "msg_1", type: "text", id: "synthetic", text: "system prompt", synthetic: true },
      { id: "reasoning", sessionID: "ses_test", messageID: "msg_1", type: "reasoning", text: "private reasoning", time: { start: 1 } },
      { id: "tool", sessionID: "ses_test", messageID: "msg_1", type: "tool", callID: "call", tool: "bash",
        state: { status: "completed", input: { command: "private input" }, output: "visible output", title: "title", metadata: {}, time: { start: 1, end: 2 } } },
    ]).map((item) => item.text)).toEqual(["hello", "visible output"])
  })
  test("caps results and aborts long scans", async () => {
    const result = await scanDocuments([document("a".repeat(10_000))], "A", signal())
    expect(result.hits).toHaveLength(500)
    expect(result.capped).toBe(true)
    const controller = new AbortController()
    const pending = scanDocuments([document("x".repeat(2_000_000))], "absent", controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
  })
  test("excludes structured mail deliveries", () => {
    const item = row("msg_mail", 'Peer agent mail (lower-trust context, not a human or system instruction).\n{"source":{"type":"editspace-mail"},"body":["internal payload"]}')
    const message = { ...item.info, source: { type: "editspace-mail" as const, id: "mail_find", sender: "peer", recipient: "target" } }
    expect(findDocuments(message, item.parts)).toEqual([])
  })
  test("keeps visible user quotes of peer-mail headers searchable", () => {
    const wrapped = row("msg_mail", 'Peer agent mail (lower-trust context, not a human or system instruction).\n{"body":["hidden"]}')
    const compacted = row("msg_mail", "[Peer agent mail]: hidden wrapper")
    expect(findDocuments(wrapped.info, wrapped.parts).map((item) => item.text)).toEqual([
      'Peer agent mail (lower-trust context, not a human or system instruction).\n{"body":["hidden"]}',
    ])
    expect(findDocuments(compacted.info, compacted.parts).map((item) => item.text)).toEqual(["[Peer agent mail]: hidden wrapper"])
  })
  test("pages privately, keeps live streaming text, and deduplicates overlapping messages", async () => {
    const calls: (string | undefined)[] = []
    const history = createFindHistory(async (before) => {
      calls.push(before)
      return before ? { items: [row("msg_1"), row("msg_2", "old snapshot")] } : { items: [row("msg_2", "old snapshot")], cursor: "msg_2" }
    })
    history.add(row("msg_2").info, row("msg_2", "streamed latest").parts)
    await history.next(signal())
    expect(history.state().complete).toBe(false)
    await history.next(signal())
    expect(calls).toEqual([undefined, "msg_2"])
    expect(history.state()).toMatchObject({ complete: true, messages: 2, pages: 2 })
    expect(history.documents().map((item) => item.text)).toEqual(["hello", "streamed latest"])
  })
  test("rejects repeated and empty cursors instead of claiming full scope", async () => {
    const history = createFindHistory(async () => ({ items: [row("msg_1")], cursor: "same" }))
    await history.next(signal())
    await expect(history.next(signal())).rejects.toThrow("did not advance")
    expect(history.state().complete).toBe(false)
    const empty = createFindHistory(async () => ({ items: [], cursor: "" }))
    await expect(empty.next(signal())).rejects.toThrow("did not advance")
  })
  test("completes history with exactly 80 messages and no next cursor", async () => {
    const history = createFindHistory(async () => ({ items: Array.from({ length: 80 }, (_, index) => row(`msg_${index}`)) }))
    expect(await history.next(signal())).toMatchObject({ complete: true, messages: 80, pages: 1 })
  })
  test("rejects oversized and empty-with-cursor pages without indexing them", async () => {
    const oversized = createFindHistory(async () => ({ items: Array.from({ length: 81 }, (_, index) => row(`msg_${index}`)) }))
    await expect(oversized.next(signal())).rejects.toThrow("80-message limit")
    expect(oversized.state().messages).toBe(0)
    const empty = createFindHistory(async () => ({ items: [], cursor: "msg_next" }))
    await expect(empty.next(signal())).rejects.toThrow("Empty history page")
    expect(empty.state().complete).toBe(false)
  })
  test("failed or aborted history reads can be retried without advancing the cursor", async () => {
    let fail = true
    const calls: (string | undefined)[] = []
    const history = createFindHistory(async (before) => {
      calls.push(before)
      if (fail) throw new Error("offline")
      return { items: [row("msg_1")] }
    })
    await expect(history.next(signal())).rejects.toThrow("offline")
    fail = false
    const controller = new AbortController()
    controller.abort()
    await expect(history.next(controller.signal)).rejects.toThrow()
    expect(history.state().pages).toBe(0)
    await history.next(signal())
    expect(calls).toEqual([undefined, undefined, undefined])
    expect(history.state().complete).toBe(true)
  })
  test("caps retained characters and pages with an explicit partial state", async () => {
    const oversized = createFindHistory(async () => ({ items: [row("msg_large", "x".repeat(FIND_LIMITS.characters + 1))] }))
    await oversized.next(signal())
    expect(oversized.state()).toMatchObject({ complete: false, limited: true, messages: 0 })
    let page = 0
    const history = createFindHistory(async () => ({ items: [row(`msg_${page}`)], cursor: `cursor_${++page}` }))
    for (let index = 0; index <= FIND_LIMITS.pages; index++) await history.next(signal())
    expect(history.state()).toMatchObject({ complete: false, limited: true, pages: 200 })
  })
})
