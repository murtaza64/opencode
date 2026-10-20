import assert from "node:assert/strict"
import { fork, execFileSync } from "node:child_process"
import { createServer } from "node:net"
import { createRequire } from "node:module"
import { setTimeout as delay } from "node:timers/promises"
import path from "node:path"

const reserve = createServer()
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve))
const port = reserve.address().port
assert.notEqual(port, 4096)
await new Promise((resolve) => reserve.close(resolve))
const manager = fork(new URL("./core-writes.mjs", import.meta.url), ["--inspector-write-guard"], {
  execArgv: [`--inspect-port=127.0.0.1:${port}`],
  stdio: ["ignore", "inherit", "inherit", "ipc"],
})
const ended = new Promise((resolve) => manager.once("exit", (code, signal) => resolve({ code, signal })))
const deadline = setTimeout(() => manager.kill("SIGTERM"), 30000)
const owned = { nativePID: 0 }
let socket
try {
  const ready = await Promise.race([
    new Promise((resolve) => manager.once("message", resolve)),
    ended.then((value) => {
      throw Error(`Manager exited before guard ready: ${JSON.stringify(value)}`)
    }),
  ])
  assert.equal(ready.phase, "guard-ready")
  owned.nativePID = ready.nativePID
  manager.kill("SIGUSR1")
  let endpoint
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(300) }).catch(
      () => undefined,
    )
    if (response?.ok)
      endpoint = (await response.json()).find((item) => item.title?.includes("core-writes.mjs"))?.webSocketDebuggerUrl
    if (endpoint) break
    await delay(50)
  }
  assert.ok(endpoint, "Private manager inspector unavailable")
  assert.equal(
    execFileSync("/usr/sbin/lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], { encoding: "utf8" }).trim(),
    String(manager.pid),
  )
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true })
    socket.addEventListener("error", reject, { once: true })
  })
  const pending = new Map()
  let sequence = 0
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data)
    if (!pending.has(message.id)) return
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) entry.reject(Error(message.error.message))
    else entry.resolve(message.result)
  })
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(Error(`Inspector ${method} timed out`))
      }, 5000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  await call("Runtime.enable")
  const require = createRequire(import.meta.url)
  const classFile = path.join(
    path.dirname(
      require.resolve("playwright-core/package.json", { paths: [path.dirname(require.resolve("@playwright/test"))] }),
    ),
    "lib/client/page.js",
  )
  const prototype = await call("Runtime.evaluate", {
    expression: `process.getBuiltinModule('module').createRequire(${JSON.stringify(classFile)})(${JSON.stringify(classFile)}).Page.prototype`,
  })
  assert.ok(prototype.result.objectId && !prototype.exceptionDetails, "Actual Playwright Page prototype unavailable")
  const objects = await call("Runtime.queryObjects", { prototypeObjectId: prototype.result.objectId })
  const check = `function () { return this.filter(page => !page._closed && page.url().startsWith(${JSON.stringify(ready.origin + "/")})).map(page => ({ routes: page._routes.map(route => route.url), contextRoutes: page.context()._routes.length, url: page.url() })) }`
  const before = await call("Runtime.callFunctionOn", {
    objectId: objects.objects.objectId,
    functionDeclaration: check,
    returnByValue: true,
  })
  assert.ok(!before.exceptionDetails)
  assert.equal(before.result.value.length, 1)
  assert.deepEqual(before.result.value[0].routes, ["**/*"])
  assert.equal(before.result.value[0].contextRoutes, 0)
  const removed = await call("Runtime.callFunctionOn", {
    objectId: objects.objects.objectId,
    functionDeclaration: `async function () {
      const pages = this.filter(page => !page._closed && page.url().startsWith(${JSON.stringify(ready.origin + "/")}));
      if (pages.length !== 1 || pages[0]._routes.length !== 1 || pages[0]._routes[0].url !== '**/*' || pages[0].context()._routes.length) throw Error('Route ownership changed');
      await pages[0].unroute('**/*');
      return { routes: pages[0]._routes.length, url: pages[0].url() };
    }`,
    awaitPromise: true,
    returnByValue: true,
  })
  assert.ok(!removed.exceptionDetails, "Inspector-owned unroute failed")
  assert.deepEqual(removed.result.value, { routes: 0, url: before.result.value[0].url })
  await call("Runtime.evaluate", {
    expression: "setTimeout(() => process.getBuiltinModule('inspector').close(), 50); true",
    returnByValue: true,
  })
  socket.close()
  for (let attempt = 0; attempt < 30; attempt++) {
    if (
      !(await fetch(`http://127.0.0.1:${port}/json/list`).then(
        () => true,
        () => false,
      ))
    )
      break
    await delay(50)
  }
  assert.equal(
    await fetch(`http://127.0.0.1:${port}/json/list`).then(
      () => true,
      () => false,
    ),
    false,
    "Inspector must be closed before writes",
  )
  console.info(
    JSON.stringify({
      phase: "inspector-guard-removed",
      manager: manager.pid,
      inspectorPort: port,
      routesBefore: 1,
      routesAfter: 0,
      inspectorClosed: true,
    }),
  )
  manager.send("recovery-complete")
  assert.deepEqual(await ended, { code: 0, signal: null })
  console.info(
    "PASS SIGUSR1 → queryObjects(actual Page.prototype) → callFunctionOn(unroute), same native process/storage, core writes and inspector cleanup",
  )
} finally {
  clearTimeout(deadline)
  socket?.close()
  if (manager.exitCode === null && manager.signalCode === null) manager.kill("SIGTERM")
  await Promise.race([ended, delay(5000)])
  if (manager.exitCode === null && manager.signalCode === null) {
    if (owned.nativePID) process.kill(owned.nativePID, "SIGKILL")
    manager.kill("SIGKILL")
  }
}
