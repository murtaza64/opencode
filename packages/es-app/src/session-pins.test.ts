import { expect, test } from "bun:test"
import { pinSessionID } from "./session-pins"

test("reads session identity from an existing directory-qualified pin", () => {
  expect(pinSessionID('["/workspace alias/مرحبا","ses_a"]')).toBe("ses_a")
})

test.each(["not json", "null", '"ses_a"', '["/workspace"]', '["/workspace",null]', '[1,"ses_a"]', '["/workspace",""]'])
  ("ignores invalid persisted pin %s", (key) => {
    expect(pinSessionID(key)).toBeUndefined()
  })
