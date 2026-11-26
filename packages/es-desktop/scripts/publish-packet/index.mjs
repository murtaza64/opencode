import assert from "node:assert/strict"
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { hash, json, readArtifact } from "./artifact.mjs"
import { compilePacket, fileMode, programFingerprint, safeName } from "./packet.mjs"

export async function lockProfile({ kind, snapshot, adoption, review }) {
  assert.ok(["laptop", "mini"].includes(kind))
  const directory = await realpath(snapshot)
  const names = kind === "laptop"
    ? ["publish.manifest.json", "exact-job-plan.json", "caller-plan.json", "source-stage-plan.json", "metadata-stage-plan.json", "artifact-stage-plan.json"]
    : ["publish.manifest.json", "caller-plan.json", "stage-plan.json", "runtime-plan.json"]
  const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, { file: `${directory}/${name}`, sha256: hash(await readFile(`${directory}/${name}`)) }])))
  const lock = { schema: "desktop-standing-runner-lock/1", kind, directory, files, adoption, review }
  const loaded = await loadProfile(lock)
  return { ...lock, programSHA: programFingerprint(loaded.profile, loaded.sources) }
}

export async function preparePacket({ profile: profileRef, parameters: parametersRef, output }) {
  const profileBytes = await readPinned(profileRef), parameterBytes = await readPinned(parametersRef)
  const locked = JSON.parse(profileBytes), parameters = JSON.parse(parameterBytes)
  const loaded = await loadProfile(locked)
  const placementBytes = await readPinned(parameters.placement), absenceBytes = await readPinned(parameters.absence)
  const placement = JSON.parse(placementBytes)
  const acceptance = (await readPinned(parameters.acceptance)).toString()
  assert.ok(acceptance.includes(parameters.accepted.source) || new RegExp(`^# [^\\n]*\\b${parameters.accepted.source.slice(0, 8)}\\b`, "m").test(acceptance), "acceptance source mismatch")
  for (const file of ["Editspace.app/Contents/Resources/app.asar", "web/index.html", "web.sha256"]) assert.ok(acceptance.includes(parameters.accepted.files[file]), `acceptance missing ${file}`)
  if (!acceptance.includes(parameters.accepted.files["RECEIPT.md"])) assert.ok(parameters.authority.receiptAmendment, "receipt drift needs DD amendment")
  const previousJournalBytes = await readPinned(parameters.previous.journal)
  assert.equal(hash(previousJournalBytes), placement.opFiles["journal.json"])
  const previousJournal = JSON.parse(previousJournalBytes)
  assert.equal(previousJournal.operation, loaded.profile.manifest.target.operation)
  assert.equal(previousJournal.jobID, loaded.profile.manifest.jobID)
  assert.equal(previousJournal.manifestSHA, loaded.profile.manifestSHA)
  assert.equal(previousJournal.cleanup, "confirmed")
  if (previousJournal.state !== "client-loaded") assert.ok(parameters.authority.priorDisposition, "unknown predecessor needs DD disposition")
  const artifact = await readArtifact(parameters.accepted)
  const compilerSHA = await compilerIdentity()
  const outputRoot = await realpath(output)
  const stateRoot = path.dirname(loaded.profile.manifest.state)
  assert.ok(outputRoot !== stateRoot && !outputRoot.startsWith(`${stateRoot}/`), "source packets cannot be written to a live execution/state tree")
  const runnerReview = JSON.parse(await readPinned(parameters.runnerReview))
  const input = { ...loaded, parameters, profileSHA: hash(profileBytes), parametersSourceSHA: hash(parameterBytes), compilerSHA, runnerReview, placement, placementBytes, absence: JSON.parse(absenceBytes), artifact, previousJournal, output: outputRoot }
  if (locked.kind === "laptop") {
    input.executorProof = JSON.parse(await readPinned(parameters.executorJobs))
    input.previousRequestBytes = await readPinned(parameters.previous.request)
    assert.equal(hash(input.previousRequestBytes), placement.opFiles["owned-web-request.json"])
    const request = JSON.parse(input.previousRequestBytes)
    const tree = JSON.parse(loaded.sources["normal-publication/web-tree.json"])
    assert.deepEqual(request.tree, tree)
    for (const [name, file] of Object.entries({ receipt: "owned-web.json", spawned: "web-spawned.json", started: "web-started.json", served: "served-web.json" })) {
      const bytes = await readPinned(parameters.previous[name])
      assert.equal(hash(bytes), placement.opFiles[file], name)
      const receipt = JSON.parse(bytes)
      if (name === "receipt") assert.deepEqual(receipt, { schema: "desktop-owned-web/1", pid: placement.web.pid, port: 3181, root: request.root, operation: loaded.profile.manifest.target.operation, requestSHA: hash(input.previousRequestBytes), indexSHA: placement.webIndex })
      if (name === "spawned") assert.deepEqual(receipt, { pid: placement.web.pid })
      if (name === "started") assert.deepEqual(receipt, { pid: placement.web.pid, start: placement.web.startUTC })
      if (name === "served") assert.deepEqual(receipt, { files: Object.values(tree).filter((entry) => entry.type === "file").length, indexSHA: placement.webIndex })
    }
    for (const [file, pin] of Object.entries(loaded.profile.caller.pins)) if (file !== loaded.profile.caller.caller) assert.equal(hash(await readFile(file)), pin, `local caller dependency drift: ${file}`)
  }
  if (locked.kind === "mini") {
    for (const [file, pin] of Object.entries(loaded.profile.manifest.files)) if (!file.startsWith(`${stateRoot}/code/`) || file === loaded.profile.manifest.oldApp.keeper.script) {
      // Current live ASAR is covered by the observed placement, not a stale fromAsar pin.
      if (file.endsWith("/Editspace.app/Contents/Resources/app.asar")) continue
      assert.equal(hash(await readFile(file)), pin, `current Mini dependency drift: ${file}`)
    }
    for (const name of ["keeper-request.json", "keeper.json", "journal.json", "native-started.json", "supervisor-started.json"]) assert.equal(hash(await readFile(`${loaded.profile.manifest.state}/${name}`)), placement.opFiles[name], `current predecessor receipt drift: ${name}`)
  }
  const packet = compilePacket(input)
  return materializePacket(packet)
}

export async function materializePacket(packet) {
  assert.equal(packet.index.state, "source-ready")
  assert.equal(packet.index.physicalScopeIssued, false)
  assert.equal(packet.index.terminal, null)
  assert.equal(hash(packet.bodies["packet-index.json"]), packet.indexSHA)
  for (const [name, pin] of Object.entries(packet.index.files)) {
    assert.ok(safeName(name))
    assert.equal(hash(packet.bodies[name]), pin, name)
  }
  assert.deepEqual(Object.keys(packet.bodies).sort(), [...Object.keys(packet.index.files), "packet-index.json"].sort())
  // Exclusive directory reservation is also an incomplete-generation marker.
  // A failure leaves it for reconciliation; it is never overwritten or retried.
  await mkdir(packet.snapshot, { mode: 0o700 })
  for (const [name, bytes] of Object.entries(packet.bodies).filter(([name]) => name !== "packet-index.json")) await writeMember(packet.snapshot, name, bytes)
  await writeMember(packet.snapshot, "packet-index.json", packet.bodies["packet-index.json"])
  return { directory: packet.snapshot, index: `${packet.snapshot}/packet-index.json`, sha256: packet.indexSHA, state: "source-ready", physicalScopeIssued: false }
}

export async function compareFrozen({ index: ref, directory }) {
  const indexBytes = await readPinned(ref), index = JSON.parse(indexBytes), root = await realpath(directory)
  assert.equal(index.schema, "desktop-generated-packet/1")
  assert.equal(index.state, "source-ready")
  const observed = []
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name)
      assert.ok(safeName(name) && !entry.isSymbolicLink())
      if (entry.isDirectory()) { await visit(name); continue }
      assert.ok(entry.isFile())
      if (name !== "packet-index.json") observed.push(name)
    }
  }
  await visit("")
  const missing = Object.keys(index.files).filter((name) => !observed.includes(name)), extra = observed.filter((name) => !Object.hasOwn(index.files, name)), mismatched = []
  for (const name of observed.filter((name) => Object.hasOwn(index.files, name))) {
    const actual = hash(await readFile(path.join(root, name)))
    if (actual !== index.files[name]) mismatched.push({ file: name, expected: index.files[name], actual })
  }
  return { schema: "desktop-packet-comparison/1", result: missing.length + extra.length + mismatched.length === 0 ? "PASS" : "FAIL", packetIndexSHA: hash(indexBytes),
    compilerSHA: index.compilerSHA, comparedFiles: observed.length, missing, extra, mismatched, pathNormalization: false, hostEffects: false }
}

export async function compilerIdentity() {
  return hash(json(Object.fromEntries(await Promise.all(["artifact.mjs", "packet.mjs", "index.mjs", "generate.mjs"].map(async (name) => [name, hash(await readFile(new URL(name, import.meta.url)))])))))
}

async function loadProfile(lock) {
  assert.equal(lock.schema, "desktop-standing-runner-lock/1")
  assert.ok(["laptop", "mini"].includes(lock.kind))
  const read = async (name) => readPinned(lock.files[name])
  const manifestBytes = await read("publish.manifest.json"), manifest = JSON.parse(manifestBytes), caller = JSON.parse(await read("caller-plan.json"))
  const stage = JSON.parse(await read(lock.kind === "laptop" ? "source-stage-plan.json" : "stage-plan.json"))
  const deploy = lock.kind === "laptop" ? stage.directory : stage.deploy
  assert.ok(path.isAbsolute(deploy))
  assert.equal(manifest.native, `${deploy}/normal-publication/native.mjs`)
  const sources = {}
  assert.equal(new Set(stage.files.map((file) => file.target)).size, stage.files.length)
  for (const file of stage.files) {
    const name = path.relative(deploy, file.target)
    assert.ok(safeName(name))
    sources[name] = await readPinned({ file: file.source, sha256: file.sha256 })
  }
  const profile = { schema: "desktop-standing-runner/1", kind: lock.kind, manifest, manifestSHA: hash(manifestBytes), deploy, caller,
    sourcePins: Object.fromEntries(Object.entries(sources).map(([name, bytes]) => [name, hash(bytes)])), adoption: lock.adoption, review: lock.review, programSHA: lock.programSHA }
  if (lock.kind === "laptop") Object.assign(profile, { plan: JSON.parse(await read("exact-job-plan.json")), sourceStage: stage, metadataStage: JSON.parse(await read("metadata-stage-plan.json")), artifactStage: JSON.parse(await read("artifact-stage-plan.json")), targetFile: "normal-publication/release-723c0f66.json" })
  if (lock.kind === "mini") profile.runtimePlan = JSON.parse(await read("runtime-plan.json"))
  return { profile, sources, manifestBytes }
}

async function readPinned(ref) {
  assert.ok(ref && path.isAbsolute(ref.file))
  assert.match(ref.sha256 ?? "", /^[a-f0-9]{64}$/)
  assert.equal(await realpath(ref.file), ref.file)
  const info = await lstat(ref.file)
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1)
  assert.equal(info.mode & 0o022, 0)
  const bytes = await readFile(ref.file)
  assert.equal(hash(bytes), ref.sha256, `input drift: ${ref.file}`)
  return bytes
}

async function writeMember(root, name, bytes) {
  assert.ok(safeName(name))
  const file = path.join(root, name)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const handle = await open(file, "wx", Number.parseInt(fileMode(name), 8))
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  assert.equal(hash(await readFile(file)), hash(bytes))
  const parent = await open(path.dirname(file), "r")
  try { await parent.sync() } finally { await parent.close() }
}
