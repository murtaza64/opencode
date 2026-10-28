import { expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import { wakeMarker, type WakeEvent } from "./wake-marker"

const input = (id: string, created: number, kind: string): Message => ({
  id, sessionID: "ses_1", role: "user", time: { created }, agent: "build", model: { providerID: "test", modelID: "m" },
  source: { type: "editspace-mail", id: `src-${id}`, sender: "es", recipient: "lane", kind },
} as UserMessage)

const reply = (id: string, parentID: string, created: number, completed?: number): Message => ({
  id, sessionID: "ses_1", role: "assistant", time: { created, ...(completed === undefined ? {} : { completed }) }, parentID,
  modelID: "m", providerID: "test", mode: "build", agent: "build", path: { cwd: "/", root: "/" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
} as AssistantMessage)

const events = (id: string, covers: string[]) => new Map<string, WakeEvent>([[`src-${id}`, { id: `src-${id}`, session: "ses_1", cause: "passive-review", at: 50, covers }]])

test("a passive review that started a turn is a wake marker with the frozen mail count", () => {
  const review = input("msg_2", 100, "passive-review")
  const history = [reply("msg_1", "msg_0", 10, 20), review, reply("msg_3", "msg_2", 110, 120)]
  expect(wakeMarker(review, history, events("msg_2", ["m1", "m2", "m3"]))).toMatchObject({
    state: "woke", label: "Woke for passive review · 3 mail", covers: ["m1", "m2", "m3"] })
})

test("an input that arrived during a running turn joined it rather than waking the agent", () => {
  const review = input("msg_2", 100, "passive-review")
  const history = [reply("msg_1", "msg_0", 10, 150), review, reply("msg_3", "msg_2", 160, 170)]
  expect(wakeMarker(review, history, events("msg_2", ["m1"]))?.label).toBe("Passive review arrived while working · 1 mail")
})

test("without a reply the wake is not confirmed, whatever the admission said", () => {
  const review = input("msg_2", 100, "passive-review")
  const marker = wakeMarker(review, [review], new Map([["src-msg_2", { id: "src-msg_2", session: "ses_1", cause: "passive-review", admission: "admitted", covers: ["m1"] }]]))
  expect(marker).toMatchObject({ state: "unconfirmed", label: "Passive review · 1 mail · wake not confirmed" })
  expect(marker?.title).toContain("no reply observed")
})

test("resume, recovery and handoff kickoffs have their own labels; a missing event omits the count", () => {
  const label = (kind: string) => {
    const kickoff = input("msg_2", 100, kind)
    return wakeMarker(kickoff, [kickoff, reply("msg_3", "msg_2", 110)], new Map())?.label
  }
  expect([label("resume"), label("recovery"), label("handoff"), label("passive-review")])
    .toEqual(["Resumed", "Recovered after restart", "Started from handoff", "Woke for passive review"])
})

test("mail, human prompts and assistant messages get no marker", () => {
  const mail = input("msg_2", 100, "notice")
  const human = { ...input("msg_4", 100, "x"), source: undefined } as unknown as Message
  expect([wakeMarker(mail, [mail], new Map()), wakeMarker(human, [human], new Map()), wakeMarker(reply("msg_5", "msg_4", 1), [], new Map())])
    .toEqual([undefined, undefined, undefined])
})
