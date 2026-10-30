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

test("WalStudio's blur and dim in colors.json shape the served wallpaper; without them the app's own blur stays", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "es-appearance-look-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const wallpaper = path.join(directory, "wall.png")
  await writeFile(wallpaper, "png bytes")
  const withLook = (studio: unknown) => JSON.stringify({ ...JSON.parse(palette(wallpaper)), studio })
  await writeFile(path.join(directory, "colors.json"), palette(wallpaper))
  const calls: (number | undefined)[] = []
  const appearance = createAppearance({ directory, debounce: 30, poll: 20, blur: async (_file, sigma) => (calls.push(sigma), Buffer.from(`sigma:${sigma}`)) })
  cleanup.push(() => appearance.close())
  await appearance.ready
  expect([calls, appearance.body()?.look]).toEqual([[undefined], undefined])
  // Writes colors.json and waits until the served look is `look`.
  const settle = async (studio: unknown, look: unknown) => {
    await writeFile(path.join(directory, "colors.json"), withLook(studio))
    for (let wait = 20; JSON.stringify(appearance.body()?.look) !== JSON.stringify(look); wait *= 2) await Bun.sleep(wait)
  }
  await settle({ blur: 8, tint: 0.95, dim: 0.3 }, { blur: 8, dim: 0.3 })
  expect(calls).toEqual([undefined, 8])
  const first = appearance.body()?.wallpaper
  // Only a new blur reblurs (and gets a new image version); dim alone is applied by the page over the same image.
  await settle({ blur: 8, dim: 0.5 }, { blur: 8, dim: 0.5 })
  expect([calls, appearance.body()?.wallpaper]).toEqual([[undefined, 8], first])
  // Out-of-range values are held to Studio's own ranges.
  await settle({ blur: 200, dim: 3 }, { blur: 64, dim: 0.8 })
  expect(appearance.body()?.wallpaper).not.toBe(first)
  // A look that is not numbers is no look: the app's own blur again.
  await settle({ blur: "16", dim: 0.2 }, undefined)
  expect(calls.at(-1)).toBeUndefined()
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

test("the receipt records what the app shows after each palette change, colours only", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "es-appearance-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, "colors.json"), palette(path.join(directory, "missing.png")))
  const receipt = path.join(directory, "receipt.json")
  const appearance = createAppearance({ directory, receipt, debounce: 30, poll: 20, blur: async () => Buffer.from("x") })
  cleanup.push(() => appearance.close())
  await appearance.ready
  const first = JSON.parse(await Bun.file(receipt).text())
  expect(first).toEqual({ schema: "es-appearance-receipt/1", background: "#101014", foreground: "#e0e0e0", updatedAt: appearance.body()!.updatedAt, applied: [] })
  await writeFile(path.join(directory, "colors.json"), palette(path.join(directory, "missing.png"), "#202024"))
  for (const delay of [50, 100, 200, 400, 800]) {
    if (JSON.parse(await Bun.file(receipt).text()).background === "#202024") break
    await Bun.sleep(delay)
  }
  expect(JSON.parse(await Bun.file(receipt).text()).background).toBe("#202024")
})

test("the receipt adds what each tab's page confirmed it applied; only this app's own pages may confirm", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "es-appearance-ack-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, "colors.json"), palette(path.join(directory, "missing.png")))
  await writeFile(path.join(directory, "palette.json"), JSON.stringify({ schema: "wal-palette/1", revision: "rev1", scheme: "dark", roles: { bg: "#000001" } }))
  const receipt = path.join(directory, "receipt.json")
  const appearance = createAppearance({ directory, receipt, debounce: 30, poll: 20, blur: async () => Buffer.from("x") })
  cleanup.push(() => appearance.close())
  await appearance.ready
  const root = await mkdtemp(path.join(tmpdir(), "es-appearance-ack-root-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, "index.html"), "<title>Fixture</title>")
  const server = await serve({ root, appearance })
  cleanup.push(() => Promise.race([server.close(), Bun.sleep(500)]))
  const post = (body: string, headers: Record<string, string> = { "x-editspace-key": server.key, origin: server.origin }) =>
    fetch(`${server.origin}/__es/appearance/applied`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body })
  expect((await post('{"walRevision":"rev1","theme":"wallpaper"}')).status).toBe(204)
  const written = JSON.parse(await Bun.file(receipt).text())
  expect(written.walRevision).toBe("rev1")
  expect(written.applied).toEqual([{ host: "local", walRevision: "rev1", theme: "wallpaper", appliedAt: expect.any(Number) }])
  expect((await post('{"walRevision":null,"theme":"default"}')).status).toBe(204)
  expect(JSON.parse(await Bun.file(receipt).text()).applied).toEqual([{ host: "local", walRevision: null, theme: "default", appliedAt: expect.any(Number) }])
  expect((await post('{"walRevision":"rev 1","theme":"wallpaper"}')).status).toBe(400)
  expect((await post('{"walRevision":"rev1","theme":"neon"}')).status).toBe(400)
  expect((await post('{"walRevision":"rev1","theme":"wallpaper"}', { "x-editspace-key": server.key })).status).toBe(403)
  expect((await post('{"walRevision":"rev1","theme":"wallpaper"}', { origin: server.origin })).status).toBe(403)
  const paired = await setup({ pairing: true })
  expect((await fetch(`${paired.server.origin}/__es/appearance/applied`, { method: "POST", body: "{}" })).status).toBe(401)
})

test("blur plan: a Studio look blurs at a work size that keeps sigma at least 4 work pixels and shows it at display width", async () => {
  const { blurPlan } = await import("./appearance")
  // The Laptop's case: a 2992px wallpaper, Studio blur 10, a 3456 device-pixel display.
  expect(blurPlan(2992, 10, 3456)).toEqual({ work: 1197, sigma: (10 * 1197) / 2992, output: 2992 })
  // A small sigma blurs at full output size; blur 0 is the image at display width, unblurred.
  expect(blurPlan(5120, 2, 3024)).toEqual({ work: 3024, sigma: (2 * 3024) / 5120, output: 3024 })
  expect(blurPlan(2992, 0, 3456)).toEqual({ work: 2992, sigma: 0, output: 2992 })
  // Never below 640 out, never past the image; a huge sigma still keeps a 16px work image.
  expect(blurPlan(400, 2, 3024).output).toBe(640)
  expect(blurPlan(5120, 5000, 3024).work).toBe(16)
})

test("gaussian blur spreads a line symmetrically by about sigma and keeps flat areas", async () => {
  const { gaussianBlur } = await import("./appearance")
  const width = 41
  const height = 9
  const pixels = new Uint8Array(width * height * 4).fill(10)
  for (let y = 0; y < height; y++) pixels.set([250, 250, 250, 250], (y * width + 20) * 4)
  gaussianBlur(pixels, width, height, 3)
  const at = (x: number) => pixels[(4 * width + x) * 4]!
  expect(at(20)).toBeGreaterThan(at(23))
  expect(at(23)).toBe(at(17))
  expect(at(0)).toBe(10)
  // One sigma out keeps about exp(-1/2) of the centre's excess.
  expect((at(23) - 10) / (at(20) - 10)).toBeGreaterThan(0.5)
  expect((at(23) - 10) / (at(20) - 10)).toBeLessThan(0.7)
})
