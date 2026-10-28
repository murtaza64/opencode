/* A decision option whose values go straight from this host's app to the approved consumer that asked
 * (dotfiles docs/es-secret-intake.md). Values are never part of an answer, a draft, storage, a URL or an
 * error message: the only write is one POST to the secure intake route, and the ledger keeps a handle. */
import type { AttentionOption, AttentionRecord } from "./attention"

export type SecretInput = { kind: "secret"; label: string; hint?: string; consumer: string; handle: string; fields: { id: string; label: string }[] }

export const secretInput = (option: AttentionOption | undefined): SecretInput | undefined => {
  const spec = option?.input
  if (spec?.kind !== "secret" || typeof spec.handle !== "string" || typeof spec.consumer !== "string" || !Array.isArray(spec.fields)) return
  return spec as SecretInput
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])

/** Only this host's own app may submit: a remote-host page or tailnet origin shows where to answer instead. */
export const secretFieldAvailable = (location: Pick<Location, "hostname">, remote: boolean) => !remote && LOOPBACK.has(location.hostname)

export const secretIntakePath = (record: Pick<AttentionRecord, "editspace" | "id" | "revision">, option: Pick<AttentionOption, "id">, handle: string) =>
  `/es/api/secret-intake/${encodeURIComponent(handle)}?${new URLSearchParams({ es: record.editspace, record: record.id, revision: String(record.revision), choice: option.id })}`

/** The first empty field's label, or undefined when every field has a value. */
export const secretMissing = (spec: SecretInput, values: Record<string, string>) =>
  spec.fields.find(field => !values[field.id]?.trim())?.label

export type SecretOutcome = { ok: true } | { ok: false; message: string; final: boolean }

/** Exactly one POST and no retry: a lost response or uncertain delivery is reported, never resent. */
export const submitSecret = async (
  record: Pick<AttentionRecord, "editspace" | "id" | "revision">,
  option: Pick<AttentionOption, "id">,
  spec: SecretInput,
  values: Record<string, string>,
  send: typeof fetch = fetch,
): Promise<SecretOutcome> => {
  const body = JSON.stringify({ values: Object.fromEntries(spec.fields.map(field => [field.id, values[field.id] ?? ""])) })
  const response = await send(secretIntakePath(record, option, spec.handle), {
    method: "POST", credentials: "include", cache: "no-store", keepalive: false, referrerPolicy: "no-referrer",
    headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body,
  }).catch(() => undefined)
  if (!response) return { ok: false, final: true, message: "Response lost. It may have been delivered; it is not resent. Ask the agent to check its status." }
  if (response.ok) return { ok: true }
  // The server's refusals are fixed sentences that never contain submitted values.
  const reason = await response.json().then((value: { error?: unknown }) => typeof value?.error === "string" ? value.error : undefined, () => undefined)
  // Refusals before delivery keep the field usable; a used, expired, unknown or uncertain field is closed.
  const final = [409, 410, 502].includes(response.status)
  return { ok: false, final, message: reason ? `${reason[0]!.toUpperCase()}${reason.slice(1)}.` : `Refused (HTTP ${response.status}); nothing was assumed.` }
}
