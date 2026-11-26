// One Personal tab when a bridged host joins the legacy Personal page at the same origin (DD #555/#559, Root #556).
// Two launches on disposable profiles, the actual laptop shape: a legacy page host (id personal, no profile) and a
// bridged excalibur host at the same origin. Fixtures only: mock keychain, a fake `security`
// first on PATH (no Keychain item is read), the bridged host unpaired (its listener answers locally, no upstream), and
// every request to a remote origin refused at the network layer and counted.
// 1. Page-only config: strip Work + Personal (page), as today.
// 2. Page + bridged: strip Work + Excalibur only; no Personal page view; the page partition is never created; Work's
//    count covers Work hosts only (the unpaired Excalibur's unavailable count stays on its own tab); the Excalibur tab
//    shows its local sign-in state, never a blank view or the page; Hosts menu order; a restore record that showed the
//    page selects Excalibur.
// Run from packages/es-desktop (after `bun run build`): node test/personal-strip.real.mjs [<packaged executable>]
import { _electron } from "@playwright/test"
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const executable = process.argv[2] ?? process.env.ES_DESKTOP_EXECUTABLE
const ORIGIN = "https://agents.murtaza.earth"
const page = { id: "personal", label: "Personal", origin: ORIGIN, mode: "page" }
const bridged = { id: "excalibur", label: "Excalibur", origin: ORIGIN, mode: "bridged", profile: "personal", kind: "pc", access: { keychain: "es-fixture-absent" } }

const bin = await mkdtemp(path.join(tmpdir(), "es-personal-strip-bin-"))
// `security find-generic-password` answers "not found": the bridged host has no Access token, so it stays unconfigured.
await writeFile(path.join(bin, "security"), "#!/bin/sh\nexit 44\n")
await chmod(path.join(bin, "security"), 0o755)
const fixture = await createFixture()
const profiles = []
const results = []
const remoteRequests = []

const launch = async (hosts, restore) => {
  const profile = await mkdtemp(path.join(tmpdir(), "es-personal-strip-profile-"))
  profiles.push(profile)
  if (restore) await writeFile(path.join(profile, "restore.json"), JSON.stringify(restore))
  const electron = await _electron.launch({
    ...(executable ? { executablePath: executable, args: ["--use-mock-keychain"] } : { args: [root, "--use-mock-keychain"] }),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ELECTRON_RUN_AS_NODE: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "",
      ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_START: "hidden", ES_REMOTE_HOSTS: JSON.stringify(hosts),
      ...(restore ? { ES_DESKTOP_RESTORE: path.join(profile, "restore.json") } : {}) },
  })
  // Renderer requests to a remote origin never leave this machine.
  await electron.context().route((url) => { const origin = new URL(url).origin; return origin === ORIGIN }, (route) => {
    remoteRequests.push(new URL(route.request().url()).origin)
    return route.abort("blockedbyclient")
  })
  return { electron, profile }
}
const settled = async (read, ok = () => true) => {
  for (let wait = 50; ; wait *= 2) {
    const value = await read().catch(() => undefined)
    if ((value !== undefined && ok(value)) || wait > 8000) return value
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
}
const barOf = (electron) => settled(async () => electron.windows().find((item) => item.url().startsWith("data:text/html") && item.url().includes("%3Cnav")))
const stripLabels = (bar) => bar.locator("nav a bdi").allTextContents()
const hostsMenu = (electron) => electron.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((item) => item.label === "Hosts").submenu.items.filter((item) => item.accelerator).map((item) => item.label))
const partitions = async (profile) => (await readdir(path.join(profile, "Partitions")).catch(() => [])).sort()
const step = (name) => results.push(`PASS ${name}`)

let running
try {
  // 1. Page-only config: unchanged.
  running = await launch([page])
  let bar = await barOf(running.electron)
  const pageOnly = await settled(() => stripLabels(bar), (labels) => labels.length === 2)
  if (JSON.stringify(pageOnly) !== JSON.stringify(["Work", "Personal"])) throw new Error(`page-only strip ${JSON.stringify(pageOnly)}`)
  step("page-only config: strip Work + Personal, as today")
  await running.electron.close(); running = undefined

  // 2. The legacy page and a bridged host at the same origin and profile; the last capture showed the page.
  running = await launch([page, bridged], { version: 1, selected: "personal", views: [{ id: "local", created: true }, { id: "personal", url: `${ORIGIN}/` }] })
  bar = await barOf(running.electron)
  const both = await settled(() => stripLabels(bar), (labels) => labels.includes("Excalibur"))
  if (JSON.stringify(both) !== JSON.stringify(["Work", "Excalibur"])) throw new Error(`strip ${JSON.stringify(both)}`)
  const current = await settled(() => bar.locator('nav a[aria-current="page"] bdi').textContent(), (text) => text === "Excalibur")
  if (current !== "Excalibur") throw new Error(`selected ${current}`)
  step("page + bridged at one origin and profile: one Personal tab (Excalibur), selected in place of the page the capture showed")

  const menu = await hostsMenu(running.electron)
  if (JSON.stringify(menu) !== JSON.stringify(["Work", "Excalibur"])) throw new Error(`Hosts menu ${JSON.stringify(menu)}`)
  if (running.electron.windows().some((item) => item.url().startsWith(ORIGIN))) throw new Error("a view shows the legacy page")
  step("Hosts menu: Work, Excalibur (Cmd+Ctrl+1..2); no view of the legacy page")

  // The Excalibur tab is its unconfigured bridged listener: a local sign-in page, never blank, never the page.
  const excalibur = await settled(async () => {
    for (const item of running.electron.windows()) {
      if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(item.url())) continue
      if ((await item.evaluate(() => document.body?.innerText ?? "")).includes("Excalibur")) return item
    }
  })
  const text = await excalibur?.evaluate(() => document.body.innerText)
  if (!text?.trim()) throw new Error("Excalibur tab is blank")
  step(`Excalibur tab shows its own unpaired state locally: ${JSON.stringify(text.trim().split("\n")[0])}`)

  // Counts: Excalibur's (unavailable while unpaired) is on its own tab; Work's tab counts Work hosts only. Counts are
  // read only while the window is visible, so show it without focus.
  const shown = await running.electron.evaluate(({ BaseWindow }) => {
    const window = BaseWindow.getAllWindows()[0]
    window?.showInactive()
    window?.emit("show")
    return { windows: BaseWindow.getAllWindows().length, visible: window?.isVisible(), minimized: window?.isMinimized() }
  })
  results.push(`window ${JSON.stringify(shown)}`)
  await bar.locator("nav a", { hasText: "Work" }).click()
  const marks = await settled(() => bar.evaluate(() => [...document.querySelectorAll("nav a")].map((a) => ({ label: a.querySelector("bdi")?.textContent, title: a.getAttribute("title") ?? "", mark: a.querySelector("b")?.getAttribute("aria-label") ?? "" }))),
    (items) => items.some((item) => item.label === "Excalibur" && /unavailable/i.test(`${item.mark} ${item.title}`)))
  const work = marks?.find((item) => item.label === "Work")
  const personal = marks?.find((item) => item.label === "Excalibur")
  if (!personal || !/unavailable/i.test(`${personal.mark} ${personal.title}`)) throw new Error(`Excalibur count ${JSON.stringify(personal)}`)
  if (!work || /unavailable/i.test(`${work.mark} ${work.title}`)) throw new Error(`Work count carries another host: ${JSON.stringify(work)}`)
  step("Excalibur's count is on its own tab; the Work tab's count is Work hosts only")

  const created = await partitions(running.profile)
  if (created.includes("editspace-host-personal")) throw new Error(`page partition created: ${JSON.stringify(created)}`)
  step(`the legacy page's partition is never opened (partitions: ${JSON.stringify(created)})`)
  if (remoteRequests.some((origin) => origin === ORIGIN)) throw new Error(`renderer requests to ${ORIGIN}: ${remoteRequests.length}`)
  step("no renderer request to the Personal origin")
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n")[0]}`)
} finally {
  console.log(results.join("\n"))
  await running?.electron.close().catch(() => undefined)
  await fixture.close?.()
  for (const profile of profiles) await rm(profile, { recursive: true, force: true })
  await rm(bin, { recursive: true, force: true })
}
