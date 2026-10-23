import { afterEach, beforeEach, expect, test } from "bun:test"
import { BACKEND_STATUS_DELAY_MS, backendIssues, backendStatus, clearBackend, describeFailure, isTransient, reportBackend, resetBackend } from "./backend-status"

beforeEach(() => resetBackend())
afterEach(() => resetBackend())
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("a brief failure never reaches the indicator", async () => {
  reportBackend("Sessions", new Error("http://127.0.0.1:4096/session: HTTP 502 {\"error\":\"bad gateway\"}"))
  await wait(BACKEND_STATUS_DELAY_MS / 4)
  clearBackend("Sessions")
  await wait(BACKEND_STATUS_DELAY_MS)
  expect(backendStatus()).toBe("")
})

test("persisting load trouble shows one updating state, and recovery clears it", async () => {
  reportBackend("Sessions", new Error("HTTP 502"))
  reportBackend("Brief checks", new TypeError("Failed to fetch"))
  reportBackend("Sessions", new Error("HTTP 502"))
  expect(backendStatus()).toBe("")
  await wait(BACKEND_STATUS_DELAY_MS + 100)
  expect(backendStatus()).toBe("updating")
  expect(backendIssues().map((issue) => issue.source)).toEqual(["Sessions", "Brief checks"])
  clearBackend("Sessions")
  clearBackend("Brief checks")
  expect(backendStatus()).toBe("")
})

test("a refused read is a problem, not load", async () => {
  reportBackend("Ignored failures", new Error("HTTP 403"))
  await wait(BACKEND_STATUS_DELAY_MS + 100)
  expect(backendStatus()).toBe("problem")
})

test("details never carry URLs or bodies", () => {
  expect(describeFailure(new Error("http://127.0.0.1:3181/oc/session/ses_x/children?directory=/a: HTTP 502 {\"name\":\"x\"}"))).toBe("service unavailable (HTTP 502)")
  expect(describeFailure(new TypeError("Failed to fetch"))).toBe("no connection")
  expect(describeFailure(new DOMException("signal timed out", "TimeoutError"))).toBe("timed out")
  expect(isTransient({ status: 503 })).toBe(true)
  expect(isTransient({ status: 403 })).toBe(false)
})
