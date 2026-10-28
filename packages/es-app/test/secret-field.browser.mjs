// A secret decision option on the Front desk, against the disposable attention fixture with a stand-in
// secure intake route: masked fields replace the note and Send; exactly one POST carries the synthetic
// canaries and no other request, URL, storage, toast or page text ever does; fields clear on submit,
// option switch (unmount) and a hidden window; refusals close the field without retry; a remote-host page
// shows where to answer instead. No runtime writes.
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const intake = { calls: [], status: 200 }
const preview = await startAttentionPreview([{
  name: "secret-intake-disposable-fixture",
  configureServer(server) {
    server.middlewares.use("/es/api/secret-intake", async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const url = new URL(req.url, "http://fixture")
      intake.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: Buffer.concat(chunks).toString(), csrf: req.headers["x-attention-csrf"] })
      const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)) }
      if (intake.status !== 200) return json({ error: "this secure field was already used; ask the agent for a new request" }, intake.status)
      const record = preview.ledger.records.find(item => item.id === url.searchParams.get("record"))
      record.status = "answered"
      record.revision += 1
      record.answer = { id: `answer-${record.id}`, text: "", choice_id: url.searchParams.get("choice"), input_value: `go-sent:${url.pathname.slice(1)}`, answered_at: Date.now(), revision: record.revision - 1 }
      record.delivery_state = "pending"
      return json({ state: "go-sent", handle: url.pathname.slice(1), record })
    })
  },
}])
const base = preview.ledger.records[1]
const handle = (id) => `sih_${id.padEnd(22, "x").slice(0, 22)}`
const gate = (id) => ({
  ...base, id, editspace: "fixture", title: "Provide the AMO signing key", gate_key: `fixture:${id}:v1`, lane: "work", recommendation: null, revision: 2,
  context: "Paste the AMO JWT issuer and secret to sign the add-on.",
  options: [{ id: "provide", label: "Provide key", input: { kind: "secret", label: "AMO API key", consumer: "amo-sign", handle: handle(id),
    fields: [{ id: "issuer", label: "JWT issuer" }, { id: "secret", label: "JWT secret" }] } }, { id: "skip", label: "Not now" }],
})
preview.ledger.records.push(gate("secret"), gate("clears"), gate("refused"), gate("remote"))
const canary = () => ({ issuer: `user:CANARY-ISSUER-${crypto.randomUUID()}`, secret: `CANARY-SECRET-${crypto.randomUUID()}` })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
const open = async (id, { remote = false } = {}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => localStorage.setItem("es-app-all-projects", "true"))
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  if (remote) await context.route("**/__es/host", route => route.fulfill({ json: { id: "laptop", label: "Laptop", remote: true, hosts: [], work: [] } }))
  const page = await context.newPage()
  const requests = []
  page.on("request", request => requests.push({ url: request.url(), method: request.method(), body: request.postData() ?? "" }))
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`${preview.url}/?item=${encodeURIComponent(`attention:fixture:${id}`)}`, { timeout: 300_000 })
  return { context, page, requests, card: page.locator(`[data-attention-id="${id}"]`) }
}
const fields = (card) => ({ issuer: card.getByLabel("JWT issuer"), secret: card.getByLabel("JWT secret") })
const traces = async (page) => page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href, text: document.body.innerText }))
try {
  {
    const values = canary()
    const { context, page, requests, card } = await open("secret")
    await card.getByRole("radio", { name: "Provide key", exact: true }).check()
    const input = fields(card)
    await expect(input.issuer).toHaveAttribute("type", "password")
    await expect(input.secret).toHaveAttribute("type", "password")
    await expect(input.secret).toHaveAttribute("autocomplete", "off")
    // The note and the ordinary Send cannot carry it.
    await expect(card.getByRole("textbox", { name: /Note/ })).toHaveCount(0)
    await expect(card.getByRole("button", { name: "Send Provide key" })).toBeDisabled()
    await expect(card.getByRole("button", { name: "Submit securely" })).toBeDisabled()
    await input.issuer.fill(values.issuer)
    await input.secret.fill(values.secret)
    await card.getByRole("button", { name: "Submit securely" }).dblclick()
    // Success files the card as answered (the field unmounts); wait on the server side, then read History.
    await expect.poll(() => intake.calls.length, { timeout: 15_000 }).toBe(1)
    await expect(fields(card).secret).toHaveCount(0, { timeout: 15_000 })
    if (intake.calls.length !== 1) throw Error(`expected exactly one intake POST, got ${intake.calls.length}`)
    const [sent] = intake.calls
    if (sent.method !== "POST" || sent.csrf !== "1" || sent.path !== `/${handle("secret")}` || JSON.stringify(sent.query) !== JSON.stringify({ es: "fixture", record: "secret", revision: "2", choice: "provide" }))
      throw Error(`intake request ${JSON.stringify({ ...sent, body: "<omitted>" })}`)
    if (JSON.stringify(JSON.parse(sent.body)) !== JSON.stringify({ values })) throw Error("intake body did not carry exactly the typed values")
    const carriers = requests.filter(request => Object.values(values).some(value => request.url.includes(value) || request.body.includes(value)))
    if (carriers.length !== 1 || !carriers[0].url.includes("/es/api/secret-intake/")) throw Error(`canary left through ${carriers.map(item => item.url).join(", ")}`)
    if (preview.ledger.calls.some(call => JSON.stringify(call).includes(values.secret) || JSON.stringify(call).includes(values.issuer))) throw Error("canary reached the attention ledger")
    await page.reload()
    await page.locator(".desk-history summary").click()
    await expect(card.locator(".home-input-value")).toContainText("Handed to the approved program")
    const after = await traces(page)
    if (Object.values(values).some(value => after.includes(value))) throw Error("canary remained in storage, URL or page text")
    await context.close()
  }
  {
    // Option switch unmounts and clears; a hidden window clears.
    const values = canary()
    const { context, page, card } = await open("clears")
    await card.getByRole("radio", { name: "Provide key", exact: true }).check()
    await fields(card).secret.fill(values.secret)
    await card.getByRole("radio", { name: "Not now", exact: true }).check()
    await card.getByRole("radio", { name: "Provide key", exact: true }).check()
    await expect(fields(card).secret).toHaveValue("")
    await fields(card).issuer.fill(values.issuer)
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")) })
    await expect(fields(card).issuer).toHaveValue("")
    await context.close()
  }
  {
    // A used/expired field closes with the server's fixed reason; nothing is resent.
    intake.status = 409
    const before = intake.calls.length
    const { context, page, card } = await open("refused")
    await card.getByRole("radio", { name: "Provide key", exact: true }).check()
    const values = canary()
    await fields(card).issuer.fill(values.issuer)
    await fields(card).secret.fill(values.secret)
    await card.getByRole("button", { name: "Submit securely" }).click()
    await expect(card.locator("[data-secret-outcome]")).toContainText("already used")
    await expect(card.getByRole("button", { name: "Submit securely" })).toBeDisabled()
    await expect(fields(card).secret).toHaveValue("")
    if (intake.calls.length !== before + 1) throw Error("refused submission was retried")
    if ((await traces(page)).includes(values.secret)) throw Error("refusal echoed the value")
    intake.status = 200
    await context.close()
  }
  {
    // A remote-host page never offers the field.
    const { context, card } = await open("remote", { remote: true })
    await card.getByRole("radio", { name: "Provide key", exact: true }).check()
    await expect(card.locator("[data-secret-unavailable]")).toContainText("computer that asked")
    await expect(card.getByLabel("JWT secret")).toHaveCount(0)
    await context.close()
  }
  const writes = preview.fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))
  if (writes.length) throw Error(`unexpected runtime writes ${JSON.stringify(writes)}`)
  if (errors.length) throw Error(errors.join("\n"))
  console.log("PASS secret field: masked inputs replace note/Send, exactly one intake POST carries the canaries, no other request/ledger call/storage/URL/page text holds them, cleared on submit/unmount/hidden, refusal closes without retry, remote page shows where to answer, no runtime writes")
} finally {
  await browser.close()
  await preview.close()
}
