import { expect, spyOn, test } from "bun:test"
import http from "node:http"
import { Server } from "../../src/server/server"
import { withTimeout } from "../../src/util/timeout"

test.each([true, false])(
  "port zero respects isolated test mode=%s without binding the production port",
  async (isolated) => {
    const home = process.env.OPENCODE_TEST_HOME
    const attempts: unknown[] = []
    let armed = false
    const listen = http.Server.prototype.listen
    // Block the default-port attempt at the OS boundary, even when running the pre-fix regression.
    const guard = spyOn(http.Server.prototype, "listen").mockImplementation(function (
      this: http.Server,
      ...args: unknown[]
    ) {
      const options = args[0]
      const port = typeof options === "object" && options !== null && "port" in options ? options.port : options
      attempts.push(port)
      if (port === 4096) {
        if (!armed) throw new Error("Test refuses to bind the production port")
        queueMicrotask(() =>
          this.emit("error", Object.assign(new Error("Synthetic port conflict"), { code: "EADDRINUSE" })),
        )
        return this
      }
      return Reflect.apply(listen, this, args)
    })
    if (isolated) process.env.OPENCODE_TEST_HOME = home ?? "/disposable-test-home"
    if (!isolated) delete process.env.OPENCODE_TEST_HOME
    try {
      // Bun's HTTP server overrides net.Server.listen; verify the guard before starting any real listener.
      expect(() => http.createServer().listen({ host: "127.0.0.1", port: 4096 })).toThrow("Test refuses")
      armed = true
      attempts.length = 0
      const listener = await withTimeout(Server.listen({ hostname: "127.0.0.1", port: 0 }), 10000, "listen isolation")
      try {
        expect(attempts).toEqual(isolated ? [0] : [4096, 0])
        expect(listener.port).not.toBe(4096)
        expect(listener.port).toBeGreaterThan(0)
        expect(new URL(listener.url).port).toBe(String(listener.port))
      } finally {
        await withTimeout(listener.stop(true), 5000, "stop isolated listener")
      }
    } finally {
      guard.mockRestore()
      if (home === undefined) delete process.env.OPENCODE_TEST_HOME
      if (home !== undefined) process.env.OPENCODE_TEST_HOME = home
    }
  },
)
