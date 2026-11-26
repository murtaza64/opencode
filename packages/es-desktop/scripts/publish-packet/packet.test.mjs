import { afterEach, expect, test } from "bun:test"
import { cp, link, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { hash, json } from "./artifact.mjs"
import { fixture } from "./fixture.mjs"
import { compareFrozen, materializePacket, preparePacket } from "./index.mjs"
import { compilePacket, programFingerprint } from "./packet.mjs"

const directories = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("same release inputs generate identical pinned execution and no terminal claim", () => {
  const input = fixture("laptop", "/decoy/output")
  const first = compilePacket(input), second = compilePacket(input)
  expect(first.indexSHA).toBe(second.indexSHA)
  expect(first.bodies["publish.manifest.json"]).toEqual(second.bodies["publish.manifest.json"])
  expect(first.index.state).toBe("source-ready")
  expect(first.index.physicalScopeIssued).toBe(false)
  expect(first.index.terminal).toBeNull()
  expect(first.index.terminalRecord.writer).toBe("mac-mini-setup")
  expect(first.index.guardPolicy.automaticReplay).toBe(false)
})

test("Laptop release preserves adopted guard programs and binds closure and caller to accepted bytes", () => {
  const input = fixture("laptop", "/decoy/output"), packet = compilePacket(input)
  const manifest = JSON.parse(packet.bodies["publish.manifest.json"]), closure = JSON.parse(packet.bodies["publish.gui-closure.json"]), caller = JSON.parse(packet.bodies["caller-plan.json"])
  expect(packet.bodies["normal-publication/native.mjs"]).toEqual(input.sources["normal-publication/native.mjs"])
  expect(packet.bodies["normal-publication/runner.mjs"]).toEqual(input.sources["normal-publication/runner.mjs"])
  expect(manifest.target.asar).toBe(input.parameters.accepted.files["Editspace.app/Contents/Resources/app.asar"])
  expect(manifest.target.fromAsar).toBe(input.profile.manifest.target.asar)
  expect(manifest.workIdle).toEqual({ quietMs: 60000, maxMs: 1800000 })
  expect(closure.files[`${packet.deploy}/publish.manifest.json`]).toBe(hash(packet.bodies["publish.manifest.json"]))
  expect(caller.remoteManifestSHA).toBe(hash(packet.bodies["publish.manifest.json"]))
  expect(caller.remoteClosureSHA).toBe(hash(packet.bodies["publish.gui-closure.json"]))
  expect(caller.argv).toEqual(["/usr/bin/ssh", "-o", "BatchMode=yes", "laptop-exec", "run", "desktop-normal-publish", "desktop-bbbbbbbb-publish-v1"])
  expect(manifest.oldApp.observed.child.pid).toBe(120)
  expect(manifest.oldApp.observed.parent.pid).toBe(119)
})

test("Mini release changes only exact shared target and caller literals and retains nonloss runner", () => {
  const input = fixture("mini", "/decoy/output"), packet = compilePacket(input)
  const manifest = JSON.parse(packet.bodies["publish.manifest.json"]), caller = JSON.parse(packet.bodies["caller-plan.json"])
  expect(packet.bodies["normal-publication/native.mjs"]).toEqual(input.sources["normal-publication/native.mjs"])
  expect(manifest.qualification.journalCookieField).toBe("cookieCountsNonLoss")
  expect(manifest.profileIdentities).toEqual(input.profile.manifest.profileIdentities)
  expect(caller.state).toBe("/decoy/mini/state/callers/desktop-publish-bbbbbbbb-mini-v1")
  expect(packet.bodies["normal-publication/shared.mjs"].toString()).toContain(JSON.stringify(manifest.target))
  expect(packet.bodies["caller.py"].toString()).toBe("OP = 'desktop-publish-bbbbbbbb-mini-v1'\nJOB = 'desktop-bbbbbbbb-mini-v1'\n")
  expect(JSON.parse(packet.bodies["runtime-plan.json"]).target).toBe(`${packet.deploy}/runtime`)
})

test("rejects cross-host placement before generating anything", () => {
  const input = fixture("mini", "/decoy/output")
  input.placement.host = "murtaza-macbook-pro"
  expect(() => compilePacket(input)).toThrow()
})

test("rejects an existing exact operation rather than selecting a fresh ID", () => {
  const input = fixture("laptop", "/decoy/output")
  input.absence["desktop-publish-bbbbbbbb-v1"].state.push("spent-job")
  expect(() => compilePacket(input)).toThrow("target exists")
  expect(input.parameters.attempt).toBe(1)
})

test("a changed attempt ID cannot bypass disposition", () => {
  const input = fixture("laptop", "/decoy/output")
  input.parameters.attempt = 2
  expect(() => compilePacket(input)).toThrow("no retry by changing IDs")
})

test("an unknown predecessor needs explicit disposition and remains unknown in evidence", () => {
  const input = fixture("laptop", "/decoy/output")
  input.previousJournal.state = "unknown"
  expect(() => compilePacket(input)).toThrow("unknown predecessor")
  input.parameters.authority.priorDisposition = "fixture DD scoped observed web only; preservation unknown"
  const packet = compilePacket(input)
  expect(input.previousJournal.state).toBe("unknown")
  expect(packet.index.guardPolicy.predecessorPhase).toBe("unknown")
  expect(packet.index.terminal).toBeNull()
})

test("rejects runner source drift even when the release parameter pins remain valid", () => {
  const input = fixture("mini", "/decoy/output")
  input.sources["normal-publication/native.mjs"] = Buffer.from("weaken preservation")
  expect(() => compilePacket(input)).toThrow("adopted source changed")
})

test("updating a source pin cannot skip standing runner review", () => {
  const input = fixture("mini", "/decoy/output")
  input.sources["normal-publication/native.mjs"] = Buffer.from("weaken preservation")
  input.profile.sourcePins["normal-publication/native.mjs"] = hash(input.sources["normal-publication/native.mjs"])
  expect(() => compilePacket(input)).toThrow("standing program fingerprint")
})

test("re-locking modified runner sources cannot reuse an independent review receipt", () => {
  const input = fixture("mini", "/decoy/output")
  input.sources["normal-publication/native.mjs"] = Buffer.from("modified runner")
  input.profile.sourcePins["normal-publication/native.mjs"] = hash(input.sources["normal-publication/native.mjs"])
  input.profile.programSHA = programFingerprint(input.profile, input.sources)
  expect(() => compilePacket(input)).toThrow("independent runner-change review")
})

test("refuses a shortened Work quiet guard", () => {
  const input = fixture("mini", "/decoy/output")
  input.profile.manifest.workIdle.quietMs = 1
  input.manifestBytes = Buffer.from(json(input.profile.manifest))
  input.profile.manifestSHA = hash(input.manifestBytes)
  expect(() => compilePacket(input)).toThrow()
})

test("retained helper needs explicit compatibility qualification", () => {
  const input = fixture("laptop", "/decoy/output")
  input.parameters.helperCompatibility = null
  expect(() => compilePacket(input)).toThrow("retained helper")
})

test("fails on asset collision before writing a packet", () => {
  const input = fixture("laptop", "/decoy/output")
  const request = JSON.parse(input.previousRequestBytes)
  request.tree["assets/shared.js"] = { type: "file", sha256: hash("old content") }
  input.previousRequestBytes = Buffer.from(json(request))
  input.sources["normal-publication/web-tree.json"] = Buffer.from(json(request.tree))
  input.profile.sourcePins["normal-publication/web-tree.json"] = hash(input.sources["normal-publication/web-tree.json"])
  input.placement.opFiles["owned-web-request.json"] = hash(input.previousRequestBytes)
  input.placement.web.argv = `${input.profile.manifest.node} ${input.profile.manifest.webStart.script} ${input.profile.manifest.state}/owned-web-request.json ${hash(input.previousRequestBytes)}`
  input.placementBytes = Buffer.from(json(input.placement))
  input.artifact.webTree["assets/shared.js"] = { type: "file", sha256: hash("new content") }
  expect(() => compilePacket(input)).toThrow("asset collision")
})

test("materializes a source-only immutable packet and refuses duplicate generation", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "publish-packet-")))
  directories.push(directory)
  const packet = compilePacket(fixture("mini", directory)), written = await materializePacket(packet)
  expect(written.state).toBe("source-ready")
  expect(written.physicalScopeIssued).toBe(false)
  expect(hash(await readFile(written.index))).toBe(written.sha256)
  await expect(materializePacket(packet)).rejects.toThrow()
  expect(hash(await readFile(written.index))).toBe(written.sha256)
  expect((await readdir(directory)).length).toBe(1)
})

test("tampering with a generated member cannot create an apparently complete packet", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "publish-packet-")))
  directories.push(directory)
  const packet = compilePacket(fixture("mini", directory))
  packet.bodies["normal-publication/native.mjs"] = Buffer.from("changed after compile")
  await expect(materializePacket(packet)).rejects.toThrow()
  expect(await readdir(directory)).toEqual([])
})

test("raw comparison detects a changed frozen member without normalizing it away", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "publish-packet-")))
  directories.push(directory)
  const packet = compilePacket(fixture("mini", directory)), written = await materializePacket(packet)
  const hand = `${directory}/hand-frozen`
  await cp(written.directory, hand, { recursive: true })
  const ref = { file: written.index, sha256: written.sha256 }
  expect((await compareFrozen({ index: ref, directory: hand })).result).toBe("PASS")
  await rm(`${hand}/normal-publication/native.mjs`)
  await writeFile(`${hand}/normal-publication/native.mjs`, "changed guard", { mode: 0o444 })
  const changed = await compareFrozen({ index: ref, directory: hand })
  expect(changed.result).toBe("FAIL")
  expect(changed.mismatched.map((item) => item.file)).toEqual(["normal-publication/native.mjs"])
  expect(changed.pathNormalization).toBe(false)
})

test("caller state needs its own exact absence proof", () => {
  const input = fixture("laptop", "/decoy/output")
  input.absence["normal-publication-caller-20261105.1-v1"].state.push("old-attempt")
  expect(() => compilePacket(input)).toThrow("target exists")
})

test("caller state cannot move outside the adopted Setup workspace", () => {
  const input = fixture("laptop", "/decoy/output")
  input.parameters.executorWorkspace = "/decoy/another-lane/private"
  expect(() => compilePacket(input)).toThrow("adopted Setup workspace")
})

test("raw placement serialization and its exact digest survive compilation", () => {
  const input = fixture("laptop", "/decoy/output")
  input.placementBytes = Buffer.from(JSON.stringify(input.placement, null, 1) + "\n")
  const packet = compilePacket(input), manifest = JSON.parse(packet.bodies["publish.manifest.json"])
  expect(packet.bodies["provenance/placement-current.json"]).toEqual(input.placementBytes)
  expect(manifest.webStart.metadataSHA).toBe(hash(input.placementBytes))
  expect(JSON.parse(packet.bodies["normal-publication/old-app-identity.json"]).metadataSHA).toBe(hash(input.placementBytes))
})

test("an unchanged runner does not authorize a changed compiler", () => {
  const input = fixture("mini", "/decoy/output")
  input.compilerSHA = hash("unreviewed compiler")
  expect(() => compilePacket(input)).toThrow("compiler source needs independent review")
})

test("accepted ASAR identity cannot be substituted", () => {
  const input = fixture("mini", "/decoy/output")
  input.artifact.native.asarSHA = hash("unaccepted asar")
  expect(() => compilePacket(input)).toThrow()
})

test("the adopted retained-tree capacity accepts 16 and refuses 17", () => {
  const allowed = retainedFixture(15)
  expect(compilePacket(allowed).index.state).toBe("source-ready")
  const tooMany = retainedFixture(16)
  expect(() => compilePacket(tooMany)).toThrow()
})

test.each(["laptop", "mini"])("a generated %s release reuses the same normalized standing program", (kind) => {
  const input = fixture(kind, "/decoy/output"), packet = compilePacket(input)
  const next = { kind, manifest: JSON.parse(packet.bodies["publish.manifest.json"]), caller: JSON.parse(packet.bodies["caller-plan.json"]) }
  expect(programFingerprint(next, packet.bodies)).toBe(input.profile.programSHA)
})

test("a wrong sealed input hash is refused before any output is created", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "publish-packet-")))
  directories.push(directory)
  await writeFile(`${directory}/profile.json`, "{}\n", { mode: 0o444 })
  await expect(preparePacket({ profile: { file: `${directory}/profile.json`, sha256: hash("different input") }, parameters: null, output: directory })).rejects.toThrow("input drift")
  expect(await readdir(directory)).toEqual(["profile.json"])
})

test("hard-linked control input is refused even when its content hash matches", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "publish-packet-")))
  directories.push(directory)
  await writeFile(`${directory}/profile.json`, "{}\n", { mode: 0o444 })
  await link(`${directory}/profile.json`, `${directory}/alias.json`)
  await expect(preparePacket({ profile: { file: `${directory}/profile.json`, sha256: hash("{}\n") }, parameters: null, output: directory })).rejects.toThrow()
  expect((await readdir(directory)).sort()).toEqual(["alias.json", "profile.json"])
})

function retainedFixture(ancestors) {
  const input = fixture("laptop", "/decoy/output"), request = JSON.parse(input.previousRequestBytes)
  request.retainedWeb = Array.from({ length: ancestors }, (_, index) => index).reduceRight((previous, index) => ({ root: `/decoy/retained/${index}`, tree: {}, ...(previous ? { previous } : {}) }), undefined)
  input.previousRequestBytes = Buffer.from(json(request))
  input.placement.opFiles["owned-web-request.json"] = hash(input.previousRequestBytes)
  input.placement.web.argv = `${input.profile.manifest.node} ${input.profile.manifest.webStart.script} ${input.profile.manifest.state}/owned-web-request.json ${hash(input.previousRequestBytes)}`
  input.placementBytes = Buffer.from(json(input.placement))
  return input
}
