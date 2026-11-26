import { expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { hydrate, registerHydrator, shortened } from "./page-parts"

const tool = (id: string, metadata: Record<string, unknown>, output = "") =>
  ({
    id, sessionID: "ses_a", messageID: "msg_a", type: "tool", callID: id, tool: "bash",
    state: { status: "completed", input: {}, output, title: "", metadata, time: { start: 1, end: 2 } },
  }) as unknown as Part

test("only a part a compact page shortened is read in full, once while in flight, by its own session", async () => {
  const reads: string[] = []
  let release = () => {}
  const off = registerHydrator("ses_a", (_, partID) => { reads.push(partID); return new Promise<void>((resolve) => (release = resolve)) })
  const cut = tool("prt_cut", { pageTruncated: { output: 20_000 } })
  expect(shortened(cut)).toBe(true)
  expect(shortened(tool("prt_whole", {}))).toBe(false)
  // Only a metadata preview was dropped: the output is whole.
  expect(shortened(tool("prt_preview", { pageTruncated: { output: 3 } }, "abc"))).toBe(false)
  expect(shortened(tool("prt_shot", { pageTruncated: { output: 0, attachments: [{ index: 0 }] } }))).toBe(true)
  hydrate(tool("prt_whole", {}))
  hydrate(cut)
  hydrate(cut)
  expect(reads).toEqual(["prt_cut"])
  release()
  await Bun.sleep(0)
  hydrate(cut)
  expect(reads).toEqual(["prt_cut", "prt_cut"])
  off()
  release()
  await Bun.sleep(0)
  hydrate(cut)
  expect(reads).toHaveLength(2)
})
