// Canary evidence against a running secret-field-preview.mjs: seeds a card, submits unique synthetic canaries
// through the real UI, then proves the consumer digest matched and no canary is in other requests, the
// private root (ledger, WAL, journal), storage, URL or page text.
//   node test/secret-field-canary.mjs <preview origin> <fixture /fixture URL>
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const [origin, fixture] = process.argv.slice(2)
const seed = await (await fetch(fixture.replace(/\/fixture$/, "/fixture/seed"), { method: "POST", headers: { "X-Attention-CSRF": "1" } })).json()
const tag = crypto.randomUUID()
const values = { issuer: `user:CANARY-ISSUER-${tag}`, secret: `CANARY-SECRET-${tag}` }
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage()
const requests = [], responses = []
page.on("request", r => requests.push({ url: r.url(), body: r.postData() ?? "" }))
page.on("response", r => { if (r.url().includes("/es/api/secret-intake/")) responses.push(r.status()) })
await page.goto(`${origin}/?item=${encodeURIComponent(`attention:secret-preview:${seed.record}`)}`, { timeout: 200000 })
const card = page.locator(`[data-attention-id="${seed.record}"]`)
await card.getByRole("radio", { name: "Provide key", exact: true }).check()
await card.getByLabel("JWT issuer").fill(values.issuer)
await card.getByLabel("JWT secret").fill(values.secret)
await card.getByRole("button", { name: "Submit securely" }).click()
for (let i = 0; i < 100 && !responses.length; i++) await new Promise(r => setTimeout(r, 100))
await new Promise(r => setTimeout(r, 2500))
const state = await (await fetch(fixture)).json()
const digest = createHash("sha256").update(`${values.issuer}\0${values.secret}`).digest("hex")
const grep = (needle) => { try { return execFileSync("grep", ["-rlF", needle, state.root], { encoding: "utf8" }).trim() } catch { return "" } }
const trace = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, u: location.href, t: document.body.innerText }))
const carriers = requests.filter(r => r.url.includes(values.secret) || r.body.includes(values.secret) || r.url.includes(values.issuer) || r.body.includes(values.issuer)).map(r => new URL(r.url).pathname)
console.log(JSON.stringify({ handle: seed.handle, intake_status: responses, requests_with_canary: carriers,
  consumer_digest_match: state.consumer_received.some(x => x.digest === digest && x.valid),
  journal: state.journal[seed.handle], private_root_files_with_canary: grep(values.secret) + grep(values.issuer),
  page_storage_url_text_has_canary: trace.includes(values.secret) || trace.includes(values.issuer) }, null, 1))
await browser.close()
