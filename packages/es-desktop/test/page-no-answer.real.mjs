// A page host that accepts and never answers (DD #648): its tab shows "No answer … Try again" instead of a blank view;
// once the host answers, Try again loads the page and the notice is gone. The Work view is unaffected. One disposable
// launch (temp profile, mock keychain), local self-signed https page host; the answer window is shortened to 3 s.
// Run from packages/es-desktop (after `bun run build`): node test/page-no-answer.real.mjs [<packaged executable>]
import { _electron } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const executable = process.argv[2] ?? process.env.ES_DESKTOP_EXECUTABLE
const profile = await mkdtemp(path.join(tmpdir(), "es-page-no-answer-profile-"))
const certs = await mkdtemp(path.join(tmpdir(), "es-page-no-answer-cert-"))
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-days", "1",
  "-keyout", path.join(certs, "key.pem"), "-out", path.join(certs, "cert.pem")], { stdio: "ignore" })
const host = { answering: false, held: [] }
const personal = await new Promise(async (resolve) => {
  const server = createServer({ key: await readFile(path.join(certs, "key.pem")), cert: await readFile(path.join(certs, "cert.pem")) }, (_req, res) => {
    if (!host.answering) return void host.held.push(res)
    res.writeHead(200, { "content-type": "text/html" })
    res.end("<!doctype html><title>Personal fixture</title><p id=ok>ok</p>")
  })
  server.listen(0, "127.0.0.1", () => resolve({ server, origin: `https://127.0.0.1:${server.address().port}` }))
})
const fixture = await createFixture()
const restore = path.join(profile, "restore.json")
await writeFile(restore, JSON.stringify({ version: 1, selected: "personal", views: [{ id: "local", created: true }, { id: "personal", created: true }] }))
const results = []
let electron
const find = async (match, limit = 30_000) => {
  for (let wait = 50, spent = 0; spent < limit; spent += wait, wait = Math.min(wait * 2, 1000)) {
    const found = electron.windows().find((item) => match(item.url()))
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
  throw new Error("view not found")
}
try {
  electron = await _electron.launch({
    ...(executable ? { executablePath: executable, args: ["--ignore-certificate-errors", "--use-mock-keychain"] } : { args: [root, "--ignore-certificate-errors", "--use-mock-keychain"] }),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "",
      ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden", ES_DESKTOP_RESTORE: restore, ES_DESKTOP_PAGE_ANSWER_MS: "3000",
      ES_REMOTE_HOSTS: JSON.stringify([{ id: "personal", label: "Personal", origin: personal.origin, mode: "page" }]) },
  })
  const started = Date.now()
  const notice = await find((url) => url.startsWith("data:text/html") && url.includes("Page%20unavailable"))
  const waited = Date.now() - started
  const text = await notice.evaluate(() => document.body.innerText)
  if (!/no answer in 3 s/.test(text)) throw new Error(`notice text: ${text}`)
  if (waited < 2500) throw new Error(`notice after ${waited} ms`)
  results.push(`PASS a page host that never answers: notice with Try again after ${Math.round(waited / 100) / 10} s`)
  const work = await find((url) => /^http:\/\/127\.0\.0\.1:\d+\//.test(url))
  await work.waitForSelector("#root *", { timeout: 60_000 })
  results.push("PASS the Work view renders as usual")
  host.answering = true
  await notice.click("text=Try again")
  const page = await find((url) => url.startsWith(personal.origin))
  await page.waitForSelector("#ok")
  await new Promise((resolve) => setTimeout(resolve, 4000))
  if (!electron.windows().some((item) => item.url().startsWith(personal.origin))) throw new Error("the notice came back after the page answered")
  results.push("PASS once the host answers, Try again loads the page and no notice follows")
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n")[0]}`)
} finally {
  console.log(results.join("\n"))
  await electron?.close()
  host.held.forEach((res) => res.destroy())
  await fixture.close?.()
  personal.server.close()
  await rm(profile, { recursive: true, force: true })
  await rm(certs, { recursive: true, force: true })
}
