import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises"
import path from "node:path"

export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
export const json = (value) => JSON.stringify(value, null, 2) + "\n"

// Matches the adopted artifact inventory, including relative in-bundle links.
export async function artifactTree(root) {
  assert.equal(await realpath(root), root)
  const entries = {}
  async function visit(relative) {
    const file = path.join(root, relative), info = await lstat(file)
    assert.equal(info.uid, process.getuid())
    if (info.isSymbolicLink()) {
      const target = await readlink(file)
      assert.ok(!path.isAbsolute(target) && (await realpath(file)).startsWith(`${root}/`))
      entries[relative] = { type: "link", target }
      return
    }
    assert.equal(info.mode & 0o022, 0)
    if (info.isDirectory()) {
      entries[relative] = { type: "dir", mode: info.mode & 0o7777 }
      for (const name of (await readdir(file)).sort()) await visit(relative === "." ? name : path.join(relative, name))
      return
    }
    assert.ok(info.isFile() && info.nlink === 1)
    entries[relative] = { type: "file", mode: info.mode & 0o7777, size: info.size, sha256: hash(await readFile(file)) }
  }
  await visit(".")
  return entries
}

export function nativeIdentity(bytes, expected) {
  assert.equal(hash(bytes), expected)
  assert.ok(bytes.length >= 16)
  const headerSize = bytes.readUInt32LE(4), jsonSize = bytes.readUInt32LE(12)
  assert.ok(headerSize > 8 && jsonSize > 0 && jsonSize <= headerSize - 8 && 8 + headerSize <= bytes.length)
  const header = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString()), entries = []
  function visit(node, prefix = "") {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      assert.ok(!name.includes("/") && name !== "..")
      const file = prefix ? `${prefix}/${name}` : name
      if (child.files) visit(child, file)
      if (!child.files) entries.push({ file, ...child })
    }
  }
  visit(header)
  function extract(entry) {
    assert.ok(entry && !entry.unpacked && !entry.link)
    const offset = 8 + headerSize + Number(entry.offset)
    assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(entry.size) && offset >= 8 + headerSize && offset + entry.size <= bytes.length)
    return bytes.subarray(offset, offset + entry.size)
  }
  const htmls = entries.filter((entry) => entry.file.endsWith("/index.html"))
  assert.equal(htmls.length, 1)
  const html = extract(htmls[0]), scripts = [...html.toString().matchAll(/src="(\/?assets\/index-[\w-]+\.js)"/g)]
  assert.equal(scripts.length, 1)
  const renderer = extract(entries.find((entry) => entry.file === `${path.posix.dirname(htmls[0].file)}/${scripts[0][1].replace(/^\//, "")}`))
  const source = renderer.toString()
  return { asarSHA: expected, renderer: `/assets/${path.posix.basename(scripts[0][1])}`, htmlSHA: hash(html), rendererSHA: hash(renderer),
    releaseNotesMarkup: { dialog: /<dialog\b/.test(source), class: /class=["']?whats-new(?:["' >])/.test(source),
      labelledby: /aria-labelledby=["']?whats-new-title(?:["' >])/.test(source), title: /id=["']?whats-new-title(?:["' >])/.test(source), actions: source.includes("whats-new-actions") } }
}

export async function readArtifact(accepted) {
  assert.match(accepted.source, /^[a-f0-9]{40}$/)
  assert.match(accepted.release, /^20\d{2}-\d{2}-\d{2}\.\d+$/)
  const root = await realpath(accepted.directory)
  for (const file of ["Editspace.app/Contents/Resources/app.asar", "Editspace.app/Contents/Resources/icon.icns", "web/index.html", "web.sha256", "RECEIPT.md", "PROVENANCE.txt"]) {
    assert.match(accepted.files[file] ?? "", /^[a-f0-9]{64}$/)
    assert.equal(hash(await readFile(`${root}/${file}`)), accepted.files[file], `accepted artifact drift: ${file}`)
  }
  assert.equal((await readFile(`${root}/SOURCE_SHA`, "utf8")).trim(), accepted.source)
  assert.equal((await readFile(`${root}/RELEASE_ID`, "utf8")).trim(), `release=${accepted.release}`)
  const native = nativeIdentity(await readFile(`${root}/Editspace.app/Contents/Resources/app.asar`), accepted.files["Editspace.app/Contents/Resources/app.asar"])
  const provenanceBytes = await readFile(`${root}/PROVENANCE.txt`), rows = provenanceBytes.toString().trim().split("\n").map((row) => row.trim().split("="))
  assert.equal(new Set(rows.map(([key]) => key)).size, rows.length)
  const provenance = Object.fromEntries(rows)
  assert.equal(provenance.source_sha, accepted.source)
  assert.equal(provenance.native_asar_sha256, native.asarSHA)
  assert.equal(provenance.web_index_html_sha256, accepted.files["web/index.html"])
  assert.equal(`/assets/${provenance.native_renderer_index}`, native.renderer)
  assert.match(provenance.web_index ?? "", /^index-[\w-]+\.js$/)
  const webIndex = await readFile(`${root}/web/index.html`, "utf8"), scripts = [...webIndex.matchAll(/src="(\/assets\/index-[\w-]+\.js)"/g)]
  assert.equal(scripts.length, 1)
  assert.equal(scripts[0][1], `/assets/${provenance.web_index}`)
  const webTree = await artifactTree(`${root}/web`), manifest = (await readFile(`${root}/web.sha256`, "utf8")).trim().split("\n")
  assert.equal(Object.values(webTree).filter((entry) => entry.type === "file").length, manifest.length)
  const names = new Set()
  for (const row of manifest) {
    const match = /^([a-f0-9]{64})\s+\*?(?:\.\/)?(?:web\/)?(.+)$/.exec(row)
    assert.ok(match)
    const name = match[2]
    assert.ok(!names.has(name) && !path.isAbsolute(name) && !name.split("/").includes(".."))
    names.add(name)
    assert.equal(webTree[name]?.sha256, match[1], name)
  }
  return { root, native, appTree: await artifactTree(`${root}/Editspace.app`), webTree, provenance: provenanceBytes,
    renderers: { native: native.renderer, web: scripts[0][1], provenanceSHA: hash(provenanceBytes), nativeHTMLSHA: native.htmlSHA, nativeRendererSHA: native.rendererSHA } }
}
