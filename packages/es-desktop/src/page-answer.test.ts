import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { watchPageAnswer } from "./page-answer"

const view = () => Object.assign(new EventEmitter(), { isDestroyed: () => false })
const start = (contents: EventEmitter, url = "https://agents.example/") =>
  contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url })

test("a navigation that never commits shows the failure page after the deadline", async () => {
  const contents = view()
  let failed = 0
  watchPageAnswer(contents, 20, () => failed++)
  start(contents)
  await Bun.sleep(40)
  expect(failed).toBe(1)
})

test("a refused navigation (cancelled before commit) does not turn into 'no answer' (DD #910)", async () => {
  // Observed on Electron 42.3.3 (DD #910 probe): a navigation refused in will-navigate emits did-start-navigation and then
  // NO failure event at all, so only the guard's own refusal can clear it. A provisional failure clears it too.
  const contents = view()
  let failed = 0
  watchPageAnswer(contents, 20, () => failed++)
  start(contents, "https://login.example/")
  contents.emit("did-fail-provisional-load", {}, -3, "ERR_ABORTED", "https://login.example/", true)
  await Bun.sleep(40)
  expect(failed).toBe(0)
  // The real order (probe log, Electron 42.3.3, same millisecond): did-start-navigation, then will-navigate (refused
  // there), then nothing. So refused() runs after the timer is armed and clears it.
  const again = view()
  const answer = watchPageAnswer(again, 20, () => failed++)
  start(again, "https://login.example/")
  answer.refused()
  await Bun.sleep(40)
  expect(failed).toBe(0)
})

test("a commit or a load failure clears it; a subframe's provisional failure does not", async () => {
  for (const [event, args] of [["did-navigate", [{}, "https://agents.example/"]], ["did-fail-load", [{}, -105, "x", "https://agents.example/", true]]] as const) {
    const contents = view()
    let failed = 0
    watchPageAnswer(contents, 20, () => failed++)
    start(contents)
    contents.emit(event, ...args)
    await Bun.sleep(40)
    expect(failed).toBe(0)
  }
  const contents = view()
  let failed = 0
  watchPageAnswer(contents, 20, () => failed++)
  start(contents)
  contents.emit("did-fail-provisional-load", {}, -3, "x", "https://frame.example/", false)
  await Bun.sleep(40)
  expect(failed).toBe(1)
})
