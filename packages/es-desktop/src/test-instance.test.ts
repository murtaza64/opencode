import { expect, test } from "bun:test"
import { testInstance } from "./test-instance"

test("the normal profile is not a test instance; a disposable profile is labeled with its name", () => {
  expect(testInstance(undefined)).toBeUndefined()
  expect(testInstance("")).toBeUndefined()
  expect(testInstance("/tmp/esprobe-work/profile")).toEqual({ label: "TEST · profile", profile: "/tmp/esprobe-work/profile" })
  expect(testInstance("/var/folders/x/T/ori-desktop-release-AbC/")?.label).toBe("TEST · ori-desktop-release-AbC")
})
