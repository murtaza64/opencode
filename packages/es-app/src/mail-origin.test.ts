import { expect, test } from "bun:test"
import { mailOrigin, squadronSender, SQUADRON_BRIDGE } from "./mail-origin"

const known = (party: string) => ["squadron-v2", "orchestrator-lane"].includes(party)

test("mail from local lanes, sessions, operators and other editspaces is Electric Sheep", () => {
  for (const from of ["squadron-v2", "ses_e9bdef7e4ffeo9XgAIryoyMX2Z", "orchestrator", "human", "workbench-upgrade/batch-orchestrator"])
    expect(mailOrigin(from, undefined, known)).toEqual({ kind: "electric-sheep" })
})

test("bridged mail is Squadron and names the workspace authors, never the bridge", () => {
  const origin = mailOrigin(SQUADRON_BRIDGE, {
    workspace_id: "5654", workspace_name: "squadron-bridge-test", ui_url: "https://infra-squadron-stage-1.duolingo.com/workspace/?workspace=5654",
    items: [{ kind: "message.created", persona: "smoke-peer" }, { kind: "message.created", persona: "easel" },
      { kind: "message.created", persona: "smoke-peer" }, { kind: "document.updated", title: "TODO" }],
  }, known)
  expect(origin).toEqual({ kind: "squadron", workspace: "squadron-bridge-test", workspaceID: "5654",
    url: "https://infra-squadron-stage-1.duolingo.com/workspace/?workspace=5654", actors: ["smoke-peer", "easel"] })
  expect(squadronSender(origin as Parameters<typeof squadronSender>[0])).toBe("smoke-peer +1")
})

test("a workspace link is kept only for an https duolingo.com origin", () => {
  for (const ui_url of ["http://infra-squadron.duolingo.com/w", "https://evil.example/w", "https://duolingo.com.evil.example/w", "javascript:alert(1)"])
    expect(mailOrigin(SQUADRON_BRIDGE, { ui_url }, known)).not.toHaveProperty("url")
})

test("bridged mail without metadata is still Squadron, with no invented details", () => {
  const origin = mailOrigin(SQUADRON_BRIDGE, undefined, known)
  expect(origin).toEqual({ kind: "squadron", actors: [] })
  expect(squadronSender(origin as Parameters<typeof squadronSender>[0])).toBe("Squadron workspace")
})

test("an unknown legacy sender gets no origin label", () => {
  expect(mailOrigin("OpenCode", undefined, known)).toBeUndefined()
  expect(mailOrigin("lane-alpha", { workspace_name: "spoof" }, known)).toBeUndefined()
})
