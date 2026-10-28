import { expect, test } from "bun:test"
import type { AttentionRecord } from "./attention"
import { inputPayload, inputProblem, inputText } from "./attention"
import { briefPacket, deskItems } from "./desk"
import { secretFieldAvailable, secretInput, secretIntakePath, submitSecret } from "./secret-field"

const HANDLE = "sih_AAAAAAAAAAAAAAAAAAAAAA"
const option = {
  id: "provide", label: "Provide key",
  input: { kind: "secret", label: "AMO API key", consumer: "amo-sign", handle: HANDLE,
    fields: [{ id: "issuer", label: "JWT issuer" }, { id: "secret", label: "JWT secret" }] },
}
const record = {
  id: "att_secret", editspace: "alpha", revision: 4, status: "open", kind: "decision", title: "Provide AMO signing key",
  context: "Paste the AMO JWT issuer and secret to sign the add-on.", options: [option, { id: "skip", label: "Not now" }],
  recommendation: null, producer_session: "ses_p", origin_session: "ses_p", gate_key: "amo-sign:aws-sso:0.1.3:v1",
  source_ref: { session_id: "ses_p", directory: "/alpha" }, decision: null, delivery_state: "not-requested", created_at: 1, updated_at: 1,
} as AttentionRecord
const canary = () => ({ issuer: `user:CANARY-ISSUER-${crypto.randomUUID()}`, secret: `CANARY-SECRET-${crypto.randomUUID()}` })

test("a secret option is recognised only with its handle, consumer and fields", () => {
  expect(secretInput(option)?.handle).toBe(HANDLE)
  expect(secretInput({ id: "x", label: "x", input: { kind: "secret", label: "x" } })).toBeUndefined()
  expect(secretInput({ id: "x", label: "x", input: { kind: "text", label: "x" } })).toBeUndefined()
})

test("only this host's own loopback app may show the field", () => {
  expect(secretFieldAvailable({ hostname: "127.0.0.1" }, false)).toBe(true)
  expect(secretFieldAvailable({ hostname: "localhost" }, false)).toBe(true)
  expect(secretFieldAvailable({ hostname: "127.0.0.1" }, true)).toBe(false)
  expect(secretFieldAvailable({ hostname: "laptop.tailnet.ts.net" }, false)).toBe(false)
})

test("an ordinary answer never carries a secret option's value and Send explains why", () => {
  const values = canary()
  expect(inputPayload(option, values.secret)).toEqual({})
  expect(inputProblem(option, values.secret)).toContain("Submit securely")
  expect(inputText(option, `go-sent:${HANDLE}`)).toBe("Handed to the approved program · values not recorded")
})

test("submission is exactly one POST to the intake route with the values only in its body", async () => {
  const values = canary()
  const calls: { url: string; init: RequestInit }[] = []
  const send = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return Response.json({ state: "go-sent", handle: HANDLE })
  }) as unknown as typeof fetch
  expect(await submitSecret(record, option, secretInput(option)!, values, send)).toEqual({ ok: true })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toBe(secretIntakePath(record, option, HANDLE))
  expect(calls[0]!.url).toBe(`/es/api/secret-intake/${HANDLE}?es=alpha&record=att_secret&revision=4&choice=provide`)
  expect(calls[0]!.init.method).toBe("POST")
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ values })
  expect(JSON.stringify(calls[0]!.init.headers)).not.toContain(values.secret)
})

test("a lost response is reported as possibly delivered and never resent", async () => {
  let calls = 0
  const send = (async () => { calls++; throw new TypeError("network") }) as unknown as typeof fetch
  const outcome = await submitSecret(record, option, secretInput(option)!, canary(), send)
  expect(calls).toBe(1)
  expect(outcome).toEqual({ ok: false, final: true, message: expect.stringContaining("not resent") })
})

test("refusals before delivery keep the field usable; used, expired or uncertain fields close", async () => {
  const outcome = (status: number) => submitSecret(record, option, secretInput(option)!, canary(),
    (async () => Response.json({ error: "fixed refusal" }, { status })) as unknown as typeof fetch)
  expect(await outcome(400)).toEqual({ ok: false, final: false, message: "Fixed refusal." })
  expect(await outcome(403)).toMatchObject({ final: false })
  expect(await outcome(409)).toMatchObject({ final: true })
  expect(await outcome(410)).toMatchObject({ final: true })
  expect(await outcome(502)).toMatchObject({ final: true })
})

test("the Front Desk brief packet names the secret input by label and kind, never its handle", () => {
  const item = deskItems({ records: [record], attentionChecked: 0, requests: [], failures: [], failuresChecked: 0, title: () => undefined, project: () => undefined })[0]!
  const packet = briefPacket(item, [])
  expect(packet.text).toContain("input: AMO API key (secret)")
  expect(JSON.stringify(packet)).not.toContain("sih_")
})
