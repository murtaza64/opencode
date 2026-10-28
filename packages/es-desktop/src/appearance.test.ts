import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAppearance } from "./appearance"
import { serve } from "./server"

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const palette = (wallpaper: string, background = "#101014") =>
  JSON.stringify({ wallpaper, special: { background, foreground: "#e0e0e0", cursor: "#ffffff" }, colors: { color0: "#101014", color1: "#ff5555", bad: "url(x)" } })

const setup = async (options: { pairing?: boolean } = {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "es-appearance-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const wallpaper = path.join(directory, "wall.png")
  await writeFile(wallpaper, "png bytes")
  await writeFile(path.join(directory, "colors.json"), palette(wallpaper))
  const blurred: string[] = []
  const appearance = createAppearance({ directory, debounce: 30, poll: 20, blur: async (file) => (blurred.push(file), Buffer.from(`blurred:${path.basename(file)}`)) })
  cleanup.push(() => appearance.close())
  await appearance.ready
  const root = await mkdtemp(path.join(tmpdir(), "es-appearance-root-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, "index.html"), "<title>Fixture</title>")
  const server = await serve({ root, appearance, ...(options.pairing ? { pairing: { code: "ABCD-EFGH-JKLM" } } : {}) })
  cleanup.push(() => Promise.race([server.close(), Bun.sleep(500)]))
  const get = (pathname: string) => fetch(`${server.origin}${pathname}`, { headers: { "x-editspace-key": server.key } })
  return { directory, wallpaper, blurred, appearance, server, get }
}

test("serves this laptop's palette and a versioned blurred wallpaper at fixed routes", async () => {
  const { get, blurred, wallpaper } = await setup()
  const body = await (await get("/__es/appearance")).json()
  expect(body.palette).toEqual({ background: "#101014", foreground: "#e0e0e0", cursor: "#ffffff", color0: "#101014", color1: "#ff5555" })
  expect(body.wallpaper).toMatch(/^\/__es\/appearance\/wallpaper\?v=\d+$/)
  const image = await get(body.wallpaper)
  expect(image.headers.get("content-type")).toBe("image/jpeg")
  expect(image.headers.get("cache-control")).toContain("immutable")
  expect(await image.text()).toBe("blurred:wall.png")
  expect(blurred).toEqual([wallpaper])
  expect((await get("/__es/appearance/wallpaper?v=other")).status).toBe(404)
  expect((await get("/__es/appearance/wallpaper")).status).toBe(404)
  expect((await get("/__es/appearance/wallpaper/x")).status).toBe(404)
  expect((await get("/__es/appearance/colors.json")).status).toBe(404)
})

test("a partial write keeps the last good palette; a real change notifies once and reblurs only a new wallpaper", async () => {
  const { directory, get, blurred } = await setup()
  const events = await get("/__es/appearance/events")
  const reader = events.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": ready\n\n")
  await writeFile(path.join(directory, "colors.json"), '{"special": {"backgr')
  await Bun.sleep(120)
  expect((await (await get("/__es/appearance")).json()).palette.background).toBe("#101014")
  await writeFile(path.join(directory, "colors.json"), palette(path.join(directory, "wall.png"), "#202024"))
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: changed\n\n")
  expect((await (await get("/__es/appearance")).json()).palette.background).toBe("#202024")
  expect(blurred.length).toBe(1)
  await reader.cancel()
})

test("only an existing image file named by pywal is read", async () => {
  const { directory, get, blurred } = await setup()
  await writeFile(path.join(directory, "colors.json"), palette(path.join(directory, "secret.txt")))
  await writeFile(path.join(directory, "secret.txt"), "private")
  let body = await (await get("/__es/appearance")).json()
  for (let i = 0; i < 50 && body.wallpaper; i++) {
    await Bun.sleep(40)
    body = await (await get("/__es/appearance")).json()
  }
  expect(body.wallpaper).toBeUndefined()
  expect(blurred.every((file) => file.endsWith("wall.png"))).toBe(true)
})

test("appearance needs the app's key and is never offered to paired remote clients", async () => {
  const { server } = await setup()
  expect((await fetch(`${server.origin}/__es/appearance`)).status).toBe(403)
  expect((await fetch(`${server.origin}/__es/appearance`, { method: "POST", headers: { "x-editspace-key": server.key } })).status).toBe(404)
  const paired = await setup({ pairing: true })
  expect((await fetch(`${paired.server.origin}/__es/appearance`)).status).toBe(401)
})

test("without a pywal palette there is no appearance", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "es-appearance-none-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const appearance = createAppearance({ directory, blur: async () => Buffer.alloc(0) })
  cleanup.push(() => appearance.close())
  await appearance.ready
  expect(appearance.body()).toBeUndefined()
})

test("a remote host's tab gets this laptop's appearance without asking the remote host", async () => {
  const { appearance } = await setup()
  const seen: string[] = []
  const mini = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => (seen.push(new URL(request.url).pathname), Response.json({})) })
  cleanup.push(() => mini.stop(true))
  const root = await mkdtemp(path.join(tmpdir(), "es-appearance-mini-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, "index.html"), "<title>Fixture</title>")
  const server = await serve({ root, remote: { id: "mini", origin: mini.url.origin }, appearance })
  cleanup.push(() => Promise.race([server.close(), Bun.sleep(500)]))
  const body = await (await fetch(`${server.origin}/__es/appearance`, { headers: { "x-editspace-key": server.key } })).json()
  expect(body).toEqual(appearance.body())
  expect(seen).toEqual([])
})

// pywal's wal-palette/1 export (docs/wal-palette.md), trimmed.
const contract = (revision: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: "wal-palette/1",
    revision,
    scheme: "dark",
    roles: { bg: "#000001", surface: "#10151f", fg: "#c4dee5", accent: "#8496cb", ok: "#6dc188", risk: "#b26d81", on_accent: "#000000", "bad role": "#ffffff", line: "var(--x)" },
    highlights: ["#3b61ad", "#3763c9", "url(x)", "#59bee7", "#4464a2", "#a5526c", "#42b76b", "#815e46", "#2c47ff", "#000000"],
    terminal: { black: "#000001" },
    checks: { ok_risk_cvd_safe: true, text_min: 4.7 },
    ...extra,
  })

test("the wal-palette/1 roles beside colors.json are served with the appearance, colours only", async () => {
  const { directory, appearance, get } = await setup()
  const events = await get("/__es/appearance/events")
  const reader = events.body!.getReader()
  await reader.read()
  await writeFile(path.join(directory, "palette.json"), contract("cb3d9b633c08"))
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: changed\n\n")
  const body = await (await get("/__es/appearance")).json()
  expect(body.palette.background).toBe("#101014")
  expect(body.wal).toEqual({
    revision: "cb3d9b633c08",
    scheme: "dark",
    roles: { bg: "#000001", surface: "#10151f", fg: "#c4dee5", accent: "#8496cb", ok: "#6dc188", risk: "#b26d81", on_accent: "#000000" },
    highlights: ["#3b61ad", "#3763c9", "#59bee7", "#4464a2", "#a5526c", "#42b76b", "#815e46", "#2c47ff"],
    okRiskCvdSafe: true,
  })
  expect(JSON.stringify(appearance.body())).not.toContain("terminal")
  await reader.cancel()
})

test("a partial palette.json keeps the last roles; another schema or a bad revision is ignored; removing it withdraws them", async () => {
  const { directory, appearance } = await setup()
  const wait = async (check: () => boolean) => { for (let i = 0; i < 50 && !check(); i++) await Bun.sleep(20) }
  await writeFile(path.join(directory, "palette.json"), contract("rev1"))
  await wait(() => appearance.body()?.wal?.revision === "rev1")
  for (const text of ['{"schema": "wal-pal', contract("rev2", { schema: "wal-palette/2" }), contract("rev 3"), contract("rev4", { roles: {} })]) {
    await writeFile(path.join(directory, "palette.json"), text)
    await Bun.sleep(120)
    expect(appearance.body()?.wal?.revision).toBe("rev1")
  }
  await rm(path.join(directory, "palette.json"))
  await wait(() => appearance.body()?.wal === undefined)
  expect(appearance.body()?.wal).toBeUndefined()
  expect(appearance.body()?.palette.background).toBe("#101014")
})

test("a device with palette.json and no colors.json serves the roles with no app theme", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "es-appearance-contract-only-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, "palette.json"), contract("only"))
  const appearance = createAppearance({ directory, blur: async () => Buffer.alloc(0) })
  cleanup.push(() => appearance.close())
  await appearance.ready
  expect(appearance.body()).toMatchObject({ palette: {}, wal: { revision: "only", okRiskCvdSafe: true } })
  expect(appearance.body()?.wallpaper).toBeUndefined()
})
