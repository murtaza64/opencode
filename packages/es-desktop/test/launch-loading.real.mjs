// A launch restored onto a host whose document is slow (DD #666): the window reads "Loading Personal…" while the page
// host has not answered, never a plain dark view; once the page's document is ready the cover is gone and the page shows.
// One disposable launch (temp profile, mock keychain), local self-signed https page host that holds its answer.
// Run from packages/es-desktop (after `bun run build`): node test/launch-loading.real.mjs [<packaged executable>]
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
const profile = await mkdtemp(path.join(tmpdir(), "es-launch-loading-profile-"))
const certs = await mkdtemp(path.join(tmpdir(), "es-launch-loading-cert-"))
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-days", "1",
  "-keyout", path.join(certs, "key.pem"), "-out", path.join(certs, "cert.pem")], { stdio: "ignore" })
const host = { answering: false, held: [] }
const answer = (res) => {
  res.writeHead(200, { "content-type": "text/html" })
  res.end("<!doctype html><title>Personal fixture</title><p id=ok>ok</p>")
}
const personal = await new Promise(async (resolve) => {
  const server = createServer({ key: await readFile(path.join(certs, "key.pem")), cert: await readFile(path.join(certs, "cert.pem")) }, (_req, res) => {
    if (!host.answering) return void host.held.push(res)
    answer(res)
  })
  server.listen(0, "127.0.0.1", () => resolve({ server, origin: `https://127.0.0.1:${server.address().port}` }))
})
const fixture = await createFixture()
const restore = path.join(profile, "restore.json")
await writeFile(restore, JSON.stringify({ version: 1, selected: "personal", views: [{ id: "local", created: true }, { id: "personal", created: true }] }))
const results = []
let electron
const until = async (check, what, limit = 30_000) => {
  for (let wait = 50, spent = 0; spent < limit; spent += wait, wait = Math.min(wait * 2, 1000)) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
  throw new Error(`timed out: ${what}`)
}
// Whether the loading cover view is visible, read from the main process (undefined when there is no cover).
const coverShown = () => electron.evaluate(({ BaseWindow }) => {
  const cover = BaseWindow.getAllWindows()[0]?.contentView.children.find((item) => item.webContents?.getURL().includes("%3Ctitle%3ELoading%3C%2Ftitle%3E"))
  return cover ? cover.getVisible() : undefined
})
try {
  electron = await _electron.launch({
    ...(executable ? { executablePath: executable, args: ["--ignore-certificate-errors", "--use-mock-keychain"] } : { args: [root, "--ignore-certificate-errors", "--use-mock-keychain"] }),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "",
      ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden", ES_DESKTOP_RESTORE: restore,
      ES_REMOTE_HOSTS: JSON.stringify([{ id: "personal", label: "Personal", origin: personal.origin, mode: "page" }]) },
  })
  const cover = await until(() => electron.windows().find((item) => item.url().includes("%3Ctitle%3ELoading%3C%2Ftitle%3E")), "loading cover")
  const text = await cover.evaluate(() => document.getElementById("loading")?.innerText ?? "")
  if (text !== "Loading Personal…") throw new Error(`cover text: ${JSON.stringify(text)}`)
  await until(async () => (await coverShown()) === true, "cover visible while the host holds its answer")
  results.push("PASS a launch restored onto a slow page host reads Loading Personal…")
  host.answering = true
  host.held.splice(0).forEach(answer)
  const page = await until(() => electron.windows().find((item) => item.url().startsWith(personal.origin)), "Personal page")
  await page.waitForSelector("#ok")
  await until(async () => (await coverShown()) === false, "cover hidden once the page is ready")
  results.push("PASS once the page's document is ready the cover is gone")
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
