import { expect, test } from "bun:test"
import { modeHref } from "./mode"

test("Agents tab never leads to a redirect that lands back on the desk", () => {
  expect(modeHref("agents", "desk", "/desk?item=attention%3Aes%3Aid")).toBe("/agents")
  expect(modeHref("agents", "desk", "/map")).toBe("/agents")
})

test("a recorded URL from the other mode falls back to that mode's home", () => {
  expect(modeHref("agents", "desk", "/?item=x")).toBe("/agents")
  expect(modeHref("desk", "agents", "/session/ses_a")).toBe("/")
})

test("each tab returns to its last recorded place, or home when already current", () => {
  expect(modeHref("agents", "desk", "/session/ses_a?directory=%2Fx")).toBe("/session/ses_a?directory=%2Fx")
  expect(modeHref("desk", "agents", "/?item=x")).toBe("/?item=x")
  expect(modeHref("agents", "agents", "/session/ses_a")).toBe("/agents")
  expect(modeHref("agents", "desk", null)).toBe("/agents")
})
