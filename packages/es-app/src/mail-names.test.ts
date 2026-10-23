import { expect, test } from "bun:test"
import { mailName, recipientSession, type MailNameSources } from "./mail-names"

const lane = (name: string) => JSON.stringify(["opencode", name])
const titles: Record<string, string> = {
  ses_relay: "Relay",
  ses_relay_old: "Relay (before handoff)",
  ses_tether: "Tether",
  ses_untitled: "New session - 2026-10-22T10:00:00.000Z",
  ses_other: "Somebody else",
}
const sources = (overrides: Partial<MailNameSources> = {}): MailNameSources => ({
  editspace: "opencode",
  owners: [{ lane: lane("orchestrator"), owner: "ses_relay" }, { lane: lane("squadron-v2"), owner: "ses_tether" },
    { lane: lane("blank"), owner: "ses_untitled" }],
  handoffs: [{ lane: lane("orchestrator"), predecessor: "ses_relay_old", successor: "ses_relay" }],
  title: (id) => titles[id],
  ...overrides,
})

test("a lane sent or received by its owner shows the owner's title, keeping lane and session in the tooltip", () => {
  expect(mailName(sources(), "orchestrator", "ses_relay")).toEqual({ label: "Relay", title: "Lane orchestrator · session ses_relay", named: true })
  expect(mailName(sources(), "squadron-v2", "ses_tether").label).toBe("Tether")
})

test("mail from a predecessor in verified handoff lineage shows the current owner's name", () => {
  expect(mailName(sources(), "orchestrator", "ses_relay_old")).toEqual({
    label: "Relay", title: "Lane orchestrator · session ses_relay_old → ses_relay", named: true })
})

test("mail from a session without verified continuity keeps the lane name", () => {
  expect(mailName(sources(), "orchestrator", "ses_other")).toEqual({ label: "orchestrator", title: "Lane orchestrator · session ses_other", named: false })
  expect(mailName(sources({ handoffs: [] }), "orchestrator", "ses_relay_old").label).toBe("orchestrator")
})

test("legacy mail without a recorded session keeps the lane name", () => {
  expect(mailName(sources(), "orchestrator", undefined)).toEqual({ label: "orchestrator", title: "Lane orchestrator", named: false })
  expect(mailName(sources(), "orchestrator", null).named).toBe(false)
})

test("unknown lanes, other editspaces, default titles and humans keep their address", () => {
  expect(mailName(sources(), "unknown-lane", "ses_relay").label).toBe("unknown-lane")
  expect(mailName(sources({ editspace: "dotfiles" }), "orchestrator", "ses_relay").label).toBe("orchestrator")
  expect(mailName(sources(), "blank", "ses_untitled").label).toBe("blank")
  expect(mailName(sources(), "human", undefined)).toEqual({ label: "human", title: "Human", named: false })
})

test("a session-addressed party shows that session's title", () => {
  expect(mailName(sources(), "ses_tether")).toEqual({ label: "Tether", title: "Session ses_tether", named: true })
  expect(mailName(sources(), "ses_missing").label).toBe("ses_missing")
})

test("a renamed owner is shown by its current title", () => {
  const renamed: Record<string, string> = { ...titles, ses_relay: "Relay Prime" }
  expect(mailName(sources({ title: (id) => renamed[id] }), "orchestrator", "ses_relay").label).toBe("Relay Prime")
})

test("the recipient session is evidence only when exactly one is recorded for that recipient", () => {
  expect(recipientSession([{ recipient: "orchestrator", session: "ses_relay" }], "orchestrator")).toBe("ses_relay")
  expect(recipientSession([{ recipient: "orchestrator", session: null }], "orchestrator")).toBeUndefined()
  expect(recipientSession([{ recipient: "other", session: "ses_x" }], "orchestrator")).toBeUndefined()
  expect(recipientSession([{ recipient: "orchestrator", session: "ses_a" }, { recipient: "orchestrator", session: "ses_b" }], "orchestrator")).toBeUndefined()
})

test("a cross-editspace party resolves through its home editspace's lane owner and lineage", () => {
  const owners = [...sources().owners, { lane: JSON.stringify(["home", "squadron-v2"]), owner: "ses_tether" }]
  expect(mailName(sources({ owners }), "home/squadron-v2", "ses_tether")).toEqual({
    label: "Tether", title: "Lane home/squadron-v2 · session ses_tether", named: true })
  expect(mailName(sources({ owners }), "home/squadron-v2", "ses_other").label).toBe("home/squadron-v2")
  expect(mailName(sources(), "home/squadron-v2", "ses_tether").label).toBe("home/squadron-v2")
})
