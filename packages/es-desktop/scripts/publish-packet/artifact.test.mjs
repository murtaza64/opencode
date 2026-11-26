import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { hash, nativeIdentity, readArtifact } from "./artifact.mjs"

const directories = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("extracts the actual native renderer from ASAR rather than a claimed filename", () => {
  const bytes = asar()
  const native = nativeIdentity(bytes, hash(bytes))
  expect(native.renderer).toBe("/assets/index-native.js")
  expect(native.rendererSHA).toBe(hash("export const release = 'fixture'"))
})

test("refuses native ASAR bytes that disagree with accepted identity", () => {
  expect(() => nativeIdentity(asar(), hash("other artifact"))).toThrow()
})

test("verifies both renderers, release/source, full web inventory and app inventory", async () => {
  const accepted = await artifactFixture()
  const artifact = await readArtifact(accepted)
  expect(artifact.renderers.native).toBe("/assets/index-native.js")
  expect(artifact.renderers.web).toBe("/assets/index-web.js")
  expect(artifact.webTree["assets/index-web.js"].sha256).toBe(hash("fixture-web"))
  expect(artifact.appTree["Contents/Resources/app.asar"].sha256).toBe(accepted.files["Editspace.app/Contents/Resources/app.asar"])
})

test("an extra web file cannot enter a declared accepted inventory", async () => {
  const accepted = await artifactFixture()
  await writeFile(`${accepted.directory}/web/extra.js`, "not accepted", { mode: 0o644 })
  await expect(readArtifact(accepted)).rejects.toThrow()
})

test("provenance from another full source cannot borrow accepted bytes", async () => {
  const accepted = await artifactFixture()
  accepted.source = "c".repeat(40)
  await expect(readArtifact(accepted)).rejects.toThrow()
})

function asar() {
  const html = Buffer.from('<script src="/assets/index-native.js"></script>'), renderer = Buffer.from("export const release = 'fixture'")
  const header = Buffer.from(JSON.stringify({ files: { renderer: { files: { "index.html": { offset: "0", size: html.length }, assets: { files: { "index-native.js": { offset: String(html.length), size: renderer.length } } } } } } }))
  const bytes = Buffer.alloc(16 + header.length + html.length + renderer.length)
  bytes.writeUInt32LE(8 + header.length, 4)
  bytes.writeUInt32LE(header.length, 12)
  header.copy(bytes, 16)
  html.copy(bytes, 16 + header.length)
  renderer.copy(bytes, 16 + header.length + html.length)
  return bytes
}

async function artifactFixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "publish-artifact-")))
  directories.push(directory)
  await mkdir(`${directory}/Editspace.app/Contents/Resources`, { recursive: true, mode: 0o700 })
  await mkdir(`${directory}/web/assets`, { recursive: true, mode: 0o700 })
  const source = "b".repeat(40), release = "2026-11-05.1", native = asar(), web = '<script src="/assets/index-web.js"></script>'
  const provenance = `source_sha=${source}\nweb_index=index-web.js\nweb_index_html_sha256=${hash(web)}\nnative_asar_sha256=${hash(native)}\nnative_renderer_index=index-native.js\n`
  const files = { "Editspace.app/Contents/Resources/app.asar": native, "Editspace.app/Contents/Resources/icon.icns": "fixture-icon", "web/index.html": web,
    "web/assets/index-web.js": "fixture-web", "web.sha256": `${hash(web)}  index.html\n${hash("fixture-web")}  assets/index-web.js\n`, "RECEIPT.md": "fixture receipt", "PROVENANCE.txt": provenance,
    SOURCE_SHA: source + "\n", RELEASE_ID: `release=${release}\n` }
  await Promise.all(Object.entries(files).map(([name, bytes]) => writeFile(`${directory}/${name}`, bytes, { mode: 0o644 })))
  return { directory, source, release, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])) }
}
