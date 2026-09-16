import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { tmpdir } from "./fixture/tmpdir"

test("plugin installation completes without waiting for a registry audit report", async () => {
  await using tmp = await tmpdir()
  const archive = await new Bun.Archive({
    "package/package.json": JSON.stringify({ name: "fixture", version: "1.0.0", main: "index.js" }),
    "package/index.js": "module.exports = 42\n",
  }).bytes()
  const audit = Promise.withResolvers<"audit">()
  const release = Promise.withResolvers<void>()
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push(url.pathname)
      if (url.pathname === "/fixture.tgz") return new Response(archive)
      if (url.pathname.startsWith("/-/npm/v1/security/")) {
        audit.resolve("audit")
        await release.promise
        return Response.json({})
      }
      return Response.json({ error: "Unexpected registry request" }, { status: 404 })
    },
  })
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^npm_config_/i.test(key)))
  try {
    const dir = path.join(tmp.path, "project")
    await fs.mkdir(dir)
    await Bun.write(path.join(tmp.path, "user.npmrc"), "")
    await Bun.write(path.join(tmp.path, "global.npmrc"), "")
    await Bun.write(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "fixture-project",
        version: "1.0.0",
        dependencies: { fixture: `${server.url}fixture.tgz` },
      }),
    )
    for (const key of Object.keys(previous)) delete process.env[key]
    Object.assign(process.env, {
      NPM_CONFIG_AUDIT: "true",
      NPM_CONFIG_REGISTRY: server.url.toString(),
      NPM_CONFIG_CACHE: path.join(tmp.path, "npm-cache"),
      NPM_CONFIG_USERCONFIG: path.join(tmp.path, "user.npmrc"),
      NPM_CONFIG_GLOBALCONFIG: path.join(tmp.path, "global.npmrc"),
      NPM_CONFIG_FETCH_RETRIES: "0",
    })
    const install = Effect.gen(function* () {
      const npm = yield* Npm.Service
      yield* npm.install(dir)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(Npm.node, [
          [Global.node, Global.layerWith({ cache: path.join(tmp.path, "cache"), state: path.join(tmp.path, "state") })],
        ]),
      ),
      Effect.runPromise,
    )
    try {
      expect(await Promise.race([install.then(() => "installed"), audit.promise])).toBe("installed")
      expect(await Bun.file(path.join(dir, "node_modules/fixture/index.js")).text()).toBe("module.exports = 42\n")
      expect(requests).toEqual(["/fixture.tgz"])
    } finally {
      release.resolve()
      await install
    }
  } finally {
    server.stop(true)
    for (const key of Object.keys(process.env).filter((key) => /^npm_config_/i.test(key))) delete process.env[key]
    Object.assign(process.env, previous)
  }
})
