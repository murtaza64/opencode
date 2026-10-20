import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { isUserPrompt, promptPosition, promptTarget } from "./transcript-nav"

const user = (source?: unknown) => ({ id: "u", sessionID: "ses", role: "user", time: { created: 0 }, ...(source ? { source } : {}) }) as unknown as Message
const text = (value: string, extra: Record<string, unknown> = {}) => ({ id: "p", messageID: "u", sessionID: "ses", type: "text", text: value, ...extra }) as Part

describe("user prompt navigation", () => {
  test("real prompts are typed or attached user input", () => {
    expect(isUserPrompt(user(), [text("Fix the bug")])).toBe(true)
    expect(isUserPrompt(user(), [{ id: "f", messageID: "u", sessionID: "ses", type: "file", mime: "image/png", url: "data:", filename: "a.png" } as Part])).toBe(true)
  })

  test("mail, generated input and empty rows are excluded by source, not prose", () => {
    const mail = { type: "editspace-mail", id: "m1", sender: "lane-a", recipient: "lane-b" }
    expect(isUserPrompt(user(mail), [text("Please fix the bug")])).toBe(false)
    expect(isUserPrompt(user(), [text("Resume where you left off", { synthetic: true })])).toBe(false)
    expect(isUserPrompt(user(), [text("  ")])).toBe(false)
    expect(isUserPrompt(user(), [])).toBe(false)
    // Prose that looks like mail is still a prompt when there is no mail source.
    expect(isUserPrompt(user(), [text("<editspace-mail from=x>hello</editspace-mail>")])).toBe(true)
    expect(isUserPrompt({ ...user(), role: "assistant" } as Message, [text("hi")])).toBe(false)
  })

  test("targets skip the prompt at the viewport edge", () => {
    const tops = [-900, -400, 10, 500, 1400]
    expect(promptTarget(tops, 1)).toBe(3)
    expect(promptTarget(tops, -1)).toBe(1)
    expect(promptTarget([-10, 20], -1)).toBe(-1)
    expect(promptTarget([-100], 1)).toBe(-1)
    expect(promptPosition(tops)).toEqual({ total: 5, current: 2, previous: true, next: true })
    expect(promptPosition([])).toEqual({ total: 0, current: -1, previous: false, next: false })
  })
})
