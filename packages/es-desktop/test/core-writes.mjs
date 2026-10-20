import { _electron, expect } from "@playwright/test"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"

// --write-guard must fail at POST; --recover-write-guard removes that controller-owned guard without reloading.
const root = path.resolve(import.meta.dirname, "..")
const profile = await mkdtemp(path.join(tmpdir(), "editspace-core-writes-"))
const calls = []
const backend = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const url = new URL(request.url, "http://fixture")
  calls.push({
    method: request.method,
    path: url.pathname,
    directory: url.searchParams.get("directory"),
    body: Buffer.concat(chunks).toString(),
    contentType: request.headers["content-type"],
    capabilityLeaked: "x-editspace-key" in request.headers,
  })
  response.writeHead(url.pathname.startsWith("/permission/") ? 404 : 200, { "content-type": "application/json" })
  response.end(JSON.stringify(url.pathname.startsWith("/permission/") ? { name: "PermissionNotFoundError" } : {}))
})
await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve))
const target = `http://127.0.0.1:${backend.address().port}`
expect(new URL(target).port).not.toBe("4096")
const app = await _electron.launch({
  executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  args: process.env.ES_DESKTOP_EXECUTABLE ? [] : [root],
  timeout: 20000,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    OPENCODE_URL: target,
    ES_DASHBOARD_URL: target,
    OPENCODE_SERVER_PASSWORD: "",
    ES_DESKTOP_USER_DATA: profile,
    ES_DESKTOP_RENDERER: "",
  },
})
const state = { origin: "" }
process.once("SIGTERM", () => {
  void app.close().finally(async () => {
    backend.closeAllConnections()
    backend.close()
    await rm(profile, { recursive: true, force: true })
    process.exit(1)
  })
})
try {
  const page = await app.firstWindow()
  await page.waitForURL("http://127.0.0.1:*/")
  const origin = new URL(page.url()).origin
  state.origin = origin
  expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(profile)
  expect(
    execFileSync(
      process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
      ["-tiTCP:" + new URL(origin).port, "-sTCP:LISTEN"],
      { encoding: "utf8" },
    ).trim(),
  ).toBe(String(app.process().pid))
  console.info(
    JSON.stringify({ nativePID: app.process().pid, profile, origin, backend: target, backendPID: process.pid }),
  )
  page.on("requestfailed", (request) =>
    console.info("requestfailed", request.method(), new URL(request.url()).pathname, request.failure()),
  )
  const guard = (route) => {
    if (["GET", "HEAD", "OPTIONS"].includes(route.request().method())) return route.continue()
    return route.abort()
  }
  if (
    process.argv.includes("--write-guard") ||
    process.argv.includes("--recover-write-guard") ||
    process.argv.includes("--inspector-write-guard")
  ) {
    await page.route("**/*", guard)
  }
  if (process.argv.includes("--recover-write-guard") || process.argv.includes("--inspector-write-guard")) {
    const blocked = await page.evaluate(() =>
      fetch("/oc/permission/per_fixture_blocked/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: "reject" }),
      }).then(
        (response) => ({ status: response.status }),
        (error) => ({ error: String(error) }),
      ),
    )
    expect(blocked).toEqual({ error: "TypeError: Failed to fetch" })
    expect(calls.some((call) => call.path === "/permission/per_fixture_blocked/reply")).toBe(false)
    await page.evaluate(() =>
      localStorage.setItem(
        "inspector-fixture-protected",
        JSON.stringify({
          draft: "unsent private fixture",
          admission: { status: "unknown", requestID: "msg_private_unconfirmed" },
        }),
      ),
    )
    const before = await page.evaluate(() => ({
      url: location.href,
      local: { ...localStorage },
      session: { ...sessionStorage },
    }))
    // Remove the guard from its owning controller, without replacing the app or retrying the blocked request.
    const identity = await app.evaluate(({ BrowserWindow }) => ({
      pid: process.pid,
      contents: BrowserWindow.getAllWindows()[0].webContents.id,
    }))
    if (process.argv.includes("--inspector-write-guard")) {
      process.send({ phase: "guard-ready", origin, nativePID: app.process().pid })
      await new Promise((resolve) => process.once("message", resolve))
    } else {
      await page.unroute("**/*", guard)
    }
    expect(
      await app.evaluate(({ BrowserWindow }) => ({
        pid: process.pid,
        contents: BrowserWindow.getAllWindows()[0].webContents.id,
      })),
    ).toEqual(identity)
    expect(
      await page.evaluate(() => ({ url: location.href, local: { ...localStorage }, session: { ...sessionStorage } })),
    ).toEqual(before)
    console.info(
      "PASS guard reproduces net::ERR_FAILED; owning-controller unroute leaves URL/storage unchanged without reload",
    )
  }
  for (const verification of process.argv.includes("--guard-lifecycle") ? ["normal", "throws"] : ["none"]) {
    if (verification !== "none") {
      const identity = await app.evaluate(({ BrowserWindow }) => ({
        pid: process.pid,
        contents: BrowserWindow.getAllWindows()[0].webContents.id,
      }))
      const before = await page.evaluate(() => ({
        url: location.href,
        local: { ...localStorage },
        session: { ...sessionStorage },
      }))
      await page.route("**/*", guard)
      const outcome = await (async () => {
        try {
          expect(await page.evaluate(() => fetch("/oc/session/status").then((response) => response.status))).toBe(200)
          expect(
            await page.evaluate(
              (verification) =>
                fetch(`/oc/permission/per_blocked_${verification}/reply`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ reply: "reject" }),
                }).then(
                  (response) => ({ status: response.status }),
                  (error) => ({ error: String(error) }),
                ),
              verification,
            ),
          ).toEqual({ error: "TypeError: Failed to fetch" })
          expect(calls.some((call) => call.path === `/permission/per_blocked_${verification}/reply`)).toBe(false)
          if (verification === "throws") throw Error("fixture verification failed")
          return "returned"
        } finally {
          await page.unroute("**/*", guard)
        }
      })().then(
        (value) => value,
        (error) => error.message,
      )
      expect(outcome).toBe(verification === "throws" ? "fixture verification failed" : "returned")
      expect(
        await app.evaluate(({ BrowserWindow }) => ({
          pid: process.pid,
          contents: BrowserWindow.getAllWindows()[0].webContents.id,
        })),
      ).toEqual(identity)
      expect(
        await page.evaluate(() => ({ url: location.href, local: { ...localStorage }, session: { ...sessionStorage } })),
      ).toEqual(before)
      console.info(`PASS ${verification} verification finally removed guard; same native/WebContents/URL/storage`)
    }
    for (const [method, pathname, body, header = "Content-Type"] of [
      ["GET", "/session/status", undefined],
      ["POST", `/permission/per_fixture_missing_${verification}/reply`, { reply: "reject" }],
      [
        "POST",
        `/session/ses_fixture_${verification}/input`,
        { text: "fake backend only", delivery: "queue" },
        "content-type",
      ],
      [
        "POST",
        `/session/ses_fixture_${verification}/prompt_async`,
        { parts: [{ type: "text", text: "fake backend only" }] },
      ],
      ["PATCH", `/session/ses_fixture_${verification}`, { title: "fake backend only" }],
      ["PATCH", `/session/ses_fixture_${verification}/input/input_fixture`, {
        commandID: `edit_fixture_${verification}`, expectedRevision: 0, text: "edited fake input", delivery: "steer",
      }],
    ]) {
      const result = await page.evaluate(
        async ({ method, pathname, body, header }) => {
          try {
            const response = await fetch(`/oc${pathname}?directory=%2Ffixture`, {
              method,
              ...(body ? { headers: { [header]: "application/json" }, body: JSON.stringify(body) } : {}),
            })
            return { status: response.status, body: await response.json() }
          } catch (error) {
            return { error: String(error) }
          }
        },
        { method, pathname, body, header },
      )
      console.info(
        method,
        pathname,
        JSON.stringify(result),
        "reached core",
        calls.some((call) => call.method === method && call.path === pathname),
      )
      expect(result).toEqual(
        pathname.startsWith("/permission/")
          ? { status: 404, body: { name: "PermissionNotFoundError" } }
          : { status: 200, body: {} },
      )
      expect(calls).toContainEqual({
        method,
        path: pathname,
        directory: "/fixture",
        body: body ? JSON.stringify(body) : "",
        contentType: body ? "application/json" : undefined,
        capabilityLeaked: false,
      })
    }
    expect((await fetch(`${origin}/oc/session`, { method: "POST", body: "{}", headers: { origin } })).status).toBe(403)
    expect((await fetch(`${origin}/oc/session/ses_fixture_${verification}/input/input_fixture`, {
      method: "PATCH", body: "{}", headers: { origin },
    })).status).toBe(403)
    console.info("PASS native core GET, POST permission/input/prompt, PATCH through packaged main/key hook")
  }
} finally {
  await app.close()
  if (state.origin)
    await expect
      .poll(() =>
        fetch(state.origin).then(
          () => false,
          () => true,
        ),
      )
      .toBe(true)
  backend.closeAllConnections()
  await new Promise((resolve) => backend.close(resolve))
  await rm(profile, { recursive: true, force: true })
}
