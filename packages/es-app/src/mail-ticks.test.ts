import { describe, expect, test } from "bun:test"
import type { MailDelivery, MailWakeStatus } from "./api"
import { mailLevel, mailUnread, outgoingMailTick, unreadWakeLine } from "./mail-ticks"

const delivery = (extra: Partial<MailDelivery>): MailDelivery => ({ message_id: "m#1", recipient: "ux-impl", session: "ses_r", mode: "actionable",
  state: "queued", request_id: null, error: null, presented_at: null, handled_at: null, ...extra })
const wake = (extra: Partial<MailWakeStatus>): MailWakeStatus => ({ schema: "es.mail.wake/v1", lane: "lane", session: "ses_me", state: "none", next: null,
  pending: { queued: 0, admitted: 0, unread_passive: 1 }, checked_at: 0, wake_now: true, ...extra })

describe("mail ticks", () => {
  test("one slot: sending ✓, inbox ✓✓ grey, presented ✓✓ accent, failed !", () => {
    expect(outgoingMailTick([])).toMatchObject({ tick: "sent", label: "Sending" })
    expect(outgoingMailTick([delivery({ state: "queued" })])).toMatchObject({ tick: "sent", label: "Sending · queued until ux-impl is free" })
    expect(outgoingMailTick([delivery({ state: "admitted" })])).toMatchObject({ tick: "delivered", label: "In ux-impl's inbox" })
    expect(outgoingMailTick([delivery({ state: "admitted", presented_ms: Date.parse("2026-11-05T05:07:00Z") })]).tick).toBe("read")
    expect(outgoingMailTick([delivery({ state: "queued", error: "no session" })])).toMatchObject({ tick: "failed", label: "Not delivered to ux-impl: no session" })
  })

  test("the dashboard's typed tick wins over state words", () => {
    expect(mailLevel(delivery({ state: "offered", tick: "presented" }))).toBe("presented")
    expect(mailLevel(delivery({ state: "weird", tick: "admitted" }))).toBe("inbox")
    expect(mailLevel(delivery({ state: "weird", tick: "queued" }))).toBe("sending")
  })

  test("handled is presented, never done; presented never says seen or done", () => {
    const label = outgoingMailTick([delivery({ state: "handled", presented_at: "2026-11-05T05:07:00Z", handled_at: "2026-11-05T05:09:00Z" })]).label
    expect(label).toStartWith("Read by ux-impl · ")
    expect(label).not.toMatch(/seen|done|handled|acknowledged/i)
  })

  test("the wake moves into the hover: caused, joined, passive waits for the next turn", () => {
    expect(outgoingMailTick([delivery({ state: "admitted", wake: "caused" })], () => "UX Impl").label).toBe("In UX Impl's inbox · woke UX Impl")
    expect(outgoingMailTick([delivery({ state: "admitted", wake: "joined" })]).label).toBe("In ux-impl's inbox · ux-impl was working")
    expect(outgoingMailTick([delivery({ mode: "passive", state: "recorded" })])).toMatchObject({ tick: "delivered", label: "In ux-impl's inbox · waits for ux-impl's next turn" })
  })

  test("several recipients: the lowest state wins, any failure shows, one hover line each", () => {
    const tick = outgoingMailTick([delivery({ recipient: "a", state: "presented" }), delivery({ recipient: "b", state: "admitted" })])
    expect(tick).toMatchObject({ tick: "delivered", label: "a: Read by a\nb: In b's inbox" })
    expect(outgoingMailTick([delivery({ recipient: "a", state: "presented" }), delivery({ recipient: "b", state: "failed" })]).tick).toBe("failed")
  })

  test("cross-host and successor recipients: evidence decides, the name is display only", () => {
    // A federated recipient keeps its raw address; a successor session's row is read the same way.
    expect(outgoingMailTick([delivery({ recipient: "laptop:opencode/ux-feel", session: null, state: "admitted" })]).label).toBe("In laptop:opencode/ux-feel's inbox")
    expect(outgoingMailTick([delivery({ session: "ses_successor", state: "presented" })], () => "UX Impl").label).toBe("Read by UX Impl")
  })

  test("withdrawn is its own words, not the inbox", () => {
    expect(outgoingMailTick([delivery({ state: "retired", tick: "retired" })])).toMatchObject({ tick: "sent", label: "Withdrawn before ux-impl read it" })
  })
})

describe("unread incoming mail", () => {
  test("unread = this session's delivery not yet presented", () => {
    expect(mailUnread([delivery({ session: "ses_me", mode: "passive", state: "recorded" })], "ses_me")).toBe(true)
    expect(mailUnread([delivery({ session: "ses_me", state: "presented", presented_ms: 1 })], "ses_me")).toBe(false)
    expect(mailUnread([delivery({ session: "ses_other", mode: "passive", state: "recorded" })], "ses_me")).toBe(false)
    expect(mailUnread([], "ses_me")).toBe(false)
  })

  test("the wake line comes from the scheduler only, never an invented time", () => {
    const line = (status?: MailWakeStatus, extra: Partial<MailDelivery> = {}, unavailable = false) =>
      unreadWakeLine({ status, unavailable, deliveries: [delivery({ session: "ses_me", mode: "passive", state: "recorded", ...extra })], sessionID: "ses_me", now: 1_000_000 })
    expect(line(wake({ state: "scheduled", next: { reason: "passive-review", at_ms: 1_000_000 + 12 * 60_000 } }))).toBe("Agent wakes in 12 min")
    expect(line(wake({ state: "scheduled", next: { reason: "passive-review", at_ms: 1_000_000 + 40_000 } }))).toBe("Agent wakes in 40 s")
    expect(line(wake({ state: "none" }))).toBe("No wake scheduled · read on the agent's next turn")
    expect(line(wake({ state: "waiting-idle", next: { reason: "queued-mail", at_ms: null } }))).toBe("Agent wakes when it is free")
    expect(line(wake({ state: "paused", next: { reason: "passive-review-off", at_ms: null } }))).toBe("Agent paused · no wake scheduled")
    expect(line(wake({ state: "blocked", next: { reason: "lane-parked", at_ms: null } }))).toBe("Agent paused · no wake scheduled")
    expect(line(wake({ state: "blocked", next: { reason: "no-owner-session", at_ms: null } }))).toBe("Blocked: no agent owns this lane")
    expect(line(wake({ state: "none" }), { wake: "caused" })).toBe("Agent is picking this up")
    expect(line(undefined, {}, true)).toBe("Next wake not available")
    expect(line(undefined)).toBeUndefined()
  })
})
