import { expect, test } from "bun:test"
import { HttpError } from "./api-error"

test("an HTML proxy error page collapses to the status", () => {
  expect(new HttpError(502, "<html><body><h1>502 Bad Gateway</h1></body></html>").message).toBe("HTTP 502")
})

test("long bodies are cut at 160 characters and whitespace is collapsed", () => {
  const error = new HttpError(500, `first\n\nsecond ${"x".repeat(300)}`)
  expect(error.message).toBe(`HTTP 500 first second ${"x".repeat(160 - "first second ".length)}…`)
  expect(error.body).toBe(`first\n\nsecond ${"x".repeat(300)}`)
})

test("short text and JSON bodies are kept", () => {
  expect(new HttpError(400, "unsupported image/model").message).toBe("HTTP 400 unsupported image/model")
  expect(new HttpError(409, { _tag: "Conflict" }).message).toBe('HTTP 409 {"_tag":"Conflict"}')
  expect(new HttpError(500, "").message).toBe("HTTP 500")
})
