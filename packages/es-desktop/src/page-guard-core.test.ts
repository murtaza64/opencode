import { expect, test } from "bun:test"
import { diffEntries, guardResult, hashValue } from "./page-guard-core"

const none = { password: false, file: false, contenteditable: false, frame: false, shadow: false, selection: false }
const url = "https://personal.example/notes"
const restored = { fields: [{ key: "TEXTAREA:textarea:note:0", hash: hashValue("draft the page restored") }], session: [{ key: "tab", hash: hashValue("1") }] }

test("state the page restored itself before input is not a loss", () => {
  const result = guardResult({ generation: "g", baseline: { ...restored, url }, interactedBeforeBaseline: false, interacted: false, url, current: restored, unsupported: none })
  expect(result).toMatchObject({ valid: true, urlMatch: true, fieldsAdded: 0, fieldsChanged: 0, fieldsRemoved: 0, ssAdded: 0, ssChanged: 0, ssRemoved: 0 })
  expect(result.reason).toBeUndefined()
})

test("typing, clearing and removing after the baseline all count", () => {
  const current = {
    fields: [{ key: "TEXTAREA:textarea:note:0", hash: hashValue("") }, { key: "INPUT:text:title:0", hash: hashValue("new") }],
    session: [],
  }
  expect(guardResult({ generation: "g", baseline: { ...restored, url }, interactedBeforeBaseline: false, interacted: true, url, current, unsupported: none }))
    .toMatchObject({ valid: true, fieldsAdded: 1, fieldsChanged: 1, fieldsRemoved: 0, ssAdded: 0, ssChanged: 0, ssRemoved: 1 })
})

test("input before the load settled, no baseline yet, or another URL leave the loss unknown", () => {
  const base = { generation: "g", interacted: true, url, current: restored, unsupported: none }
  expect(guardResult({ ...base, interactedBeforeBaseline: true })).toMatchObject({ valid: false, reason: "interacted", fieldsChanged: 0 })
  expect(guardResult({ ...base, interactedBeforeBaseline: false })).toMatchObject({ valid: false, reason: "not-settled" })
  expect(guardResult({ ...base, interactedBeforeBaseline: false, baseline: { ...restored, url: `${url}#other` } })).toMatchObject({ valid: false, reason: "navigated", urlMatch: false })
})

test("the result carries counts and flags only, never keys, hashes or the URL", () => {
  const text = JSON.stringify(guardResult({ generation: "g", baseline: { ...restored, url }, interactedBeforeBaseline: false, interacted: false, url, current: restored, unsupported: none }))
  expect(text).not.toContain("note")
  expect(text).not.toContain("personal.example")
  expect(text).not.toContain(hashValue("1"))
})

test("diff counts by key; hashes are stable and value-sensitive", () => {
  expect(diffEntries([{ key: "a", hash: "1" }, { key: "b", hash: "2" }], [{ key: "b", hash: "3" }, { key: "c", hash: "4" }])).toEqual({ added: 1, changed: 1, removed: 1 })
  expect(hashValue("same")).toBe(hashValue("same"))
  expect(hashValue("same")).not.toBe(hashValue("Same"))
})
