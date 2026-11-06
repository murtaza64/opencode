import { expect, test } from "bun:test"
import { agentIdentity } from "./agent-identity"

test("primary is project/lane; a registered persona is the alias only", () => {
  const identity = agentIdentity({ editspace: "opencode", lane: "ux-feel", title: "Reviewing stage frames" })
  expect(identity).toMatchObject({ key: "opencode/ux-feel", primary: "opencode/ux-feel", task: "Reviewing stage frames" })
})

test("a JSON lane pair resolves to its project and lane", () => {
  expect(agentIdentity({ lane: JSON.stringify(["fixture", "ux-impl"]) })).toMatchObject({ key: "fixture/ux-impl", primary: "fixture/ux-impl" })
})

test("a host-qualified owner keeps the host in the key", () => {
  expect(agentIdentity({ owner: "mini:opencode/front-desk" })).toMatchObject({ key: "mini:opencode/front-desk", primary: "opencode/front-desk", role: "front desk implementation" })
})

test("the Desk pointer is Porter, never the front-desk implementation lane", () => {
  expect(agentIdentity({ editspace: "opencode", lane: "front-desk", desk: true })).toMatchObject({ key: "desk", primary: "Work Front Desk", alias: "Porter" })
})
