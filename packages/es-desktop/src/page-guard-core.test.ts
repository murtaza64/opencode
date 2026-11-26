import { expect, test } from "bun:test"
import { diffEntries, guardResult, hashValue } from "./page-guard-core"

const none = { password: false, file: false, contenteditable: false, frame: false, shadow: false, selection: false }
const url = "https://personal.example/notes"
// The page now: nothing edited and quiet for a minute, loaded, nothing submitting, no dialog.
const idle = { dirtyFields: 0, quietMs: 60_000, loading: false, submitting: false, dialogs: 0 }
const restored = { fields: [{ key: "TEXTAREA:textarea:note:0", hash: hashValue("draft the page restored") }], session: [{ key: "tab", hash: hashValue("1") }] }

test("state the page restored itself before input is not a loss", () => {
  const result = guardResult({ generation: "g", baseline: { ...restored, url }, interactedBeforeBaseline: false, interacted: false, url, current: restored, unsupported: none, state: idle })
  expect(result).toMatchObject({ valid: true, urlMatch: true, fieldsAdded: 0, fieldsChanged: 0, fieldsRemoved: 0, ssAdded: 0, ssChanged: 0, ssRemoved: 0 })
  expect(result.reason).toBeUndefined()
})

test("typing, clearing and removing after the baseline all count", () => {
  const current = {
    fields: [{ key: "TEXTAREA:textarea:note:0", hash: hashValue("") }, { key: "INPUT:text:title:0", hash: hashValue("new") }],
    session: [],
  }
  expect(guardResult({ generation: "g", baseline: { ...restored, url }, interactedBeforeBaseline: false, interacted: true, url, current, unsupported: none, state: idle }))
    .toMatchObject({ valid: true, fieldsAdded: 1, fieldsChanged: 1, fieldsRemoved: 0, ssAdded: 0, ssChanged: 0, ssRemoved: 1 })
})

test("input before the load settled, no baseline yet, or another URL leave the loss unknown", () => {
  const base = { generation: "g", interacted: true, url, current: restored, unsupported: none, state: idle }
  expect(guardResult({ ...base, interactedBeforeBaseline: true })).toMatchObject({ valid: false, reason: "interacted", fieldsChanged: 0 })
  expect(guardResult({ ...base, interactedBeforeBaseline: false })).toMatchObject({ valid: false, reason: "not-settled" })
  expect(guardResult({ ...base, interactedBeforeBaseline: false, baseline: { ...restored, url: `${url}#other` } })).toMatchObject({ valid: false, reason: "navigated", urlMatch: false })
})

test("the result carries counts and flags only, never keys, hashes or the URL", () => {
  const text = JSON.stringify(guardResult({ generation: "g", baseline: { ...restored, url }, interactedBeforeBaseline: false, interacted: false, url, current: restored, unsupported: none, state: idle }))
  expect(text).not.toContain("note")
  expect(text).not.toContain("personal.example")
  expect(text).not.toContain(hashValue("1"))
})

test("diff counts by key; hashes are stable and value-sensitive", () => {
  expect(diffEntries([{ key: "a", hash: "1" }, { key: "b", hash: "2" }], [{ key: "b", hash: "3" }, { key: "c", hash: "4" }])).toEqual({ added: 1, changed: 1, removed: 1 })
  expect(hashValue("same")).toBe(hashValue("same"))
  expect(hashValue("same")).not.toBe(hashValue("Same"))
})

const read = (overrides: Partial<Parameters<typeof guardResult>[0]> = {}) =>
  guardResult({ generation: "g", baseline: { ...restored, url }, interactedBeforeBaseline: false, interacted: false, url, current: restored, unsupported: none, state: idle, ...overrides })

test("an untouched page admits on its load baseline; a loss against that baseline holds", () => {
  expect(read()).toMatchObject({ admit: true, admitBasis: "baseline" })
  expect(read({ current: { ...restored, session: [] } })).toMatchObject({ admit: false, admitBasis: "baseline", holdReason: "loss" })
})

test("after browsing in the app (navigated, typed and sent) a quiet page with no user-held text admits on its current state", () => {
  const browsed = read({ url: `${url}/other`, interacted: true })
  expect(browsed).toMatchObject({ valid: false, reason: "navigated", admit: true, admitBasis: "current" })
  expect(browsed.holdReason).toBeUndefined()
  // Input before the load settled no longer blocks by itself either.
  expect(read({ interactedBeforeBaseline: true, interacted: true })).toMatchObject({ valid: false, admit: true, admitBasis: "current" })
})

test("user text still in a field, recent typing, a load or real submission in flight, a dialog or any unsupported input hold", () => {
  const browsed = { url: `${url}/other`, interacted: true }
  expect(read({ ...browsed, state: { ...idle, dirtyFields: 1 } })).toMatchObject({ admit: false, holdReason: "dirty" })
  expect(read({ ...browsed, state: { ...idle, quietMs: 1000 } })).toMatchObject({ admit: false, holdReason: "typing" })
  expect(read({ ...browsed, state: { ...idle, loading: true } })).toMatchObject({ admit: false, holdReason: "loading" })
  expect(read({ ...browsed, state: { ...idle, submitting: true } })).toMatchObject({ admit: false, holdReason: "submitting" })
  expect(read({ ...browsed, state: { ...idle, dialogs: 1 } })).toMatchObject({ admit: false, holdReason: "dialog" })
  expect(read({ ...browsed, unsupported: { ...none, password: true } })).toMatchObject({ admit: false, holdReason: "unsupported" })
  // The baseline rule never overrides a submission or dialog in flight either.
  expect(read({ state: { ...idle, submitting: true } })).toMatchObject({ admit: false, admitBasis: "baseline", holdReason: "submitting" })
})
