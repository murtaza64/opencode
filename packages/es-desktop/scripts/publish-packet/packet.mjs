import assert from "node:assert/strict"
import path from "node:path"
import { hash, json } from "./artifact.mjs"

// Pure compilation. Host effects stay in the adopted, pinned runner and Setup.
export function compilePacket(input) {
  const profile = input.profile, p = input.parameters, old = profile.manifest
  assert.equal(profile.schema, "desktop-standing-runner/1")
  assert.equal(p.schema, "desktop-release-parameters/1")
  assert.ok(["release", "verification"].includes(p.purpose))
  assert.ok(["laptop", "mini"].includes(profile.kind))
  assert.equal(p.host, old.target.host)
  assert.equal(p.host, profile.kind === "laptop" ? "murtaza-macbook-pro" : "murtaza-mac-mini")
  assert.equal(p.runnerProfileSHA, input.profileSHA)
  assert.match(input.compilerSHA, /^[a-f0-9]{64}$/)
  assert.match(p.owner, /^ses_[A-Za-z0-9]+$/)
  assert.match(p.accepted.source, /^[a-f0-9]{40}$/)
  assert.match(p.accepted.release, /^20\d{2}-\d{2}-\d{2}\.\d+$/)
  assert.notEqual(p.accepted.source, old.target.source, "candidate already belongs to predecessor")
  assert.ok(Number.isSafeInteger(p.attempt) && p.attempt >= 1)
  if (p.attempt > 1) assert.ok(p.authority.newAttemptDisposition, "a new attempt needs explicit disposition; no retry by changing IDs")
  for (const field of ["acceptance", "runnerReview", "coreExclusion", "perf", "executor"]) assert.ok(typeof p.authority[field] === "string" && p.authority[field].length > 0, `missing authority.${field}`)
  assert.equal(p.authority.scopeOwner, "desktop-delivery")
  assert.equal(profile.adoption.state, "adopted")
  assert.ok(profile.adoption.evidence && profile.review)
  assert.equal(profile.manifestSHA, hash(input.manifestBytes))
  assert.deepEqual(JSON.parse(input.manifestBytes), old)
  assert.equal(Object.hasOwn(old, "debugMetadata"), false)
  assert.equal(old.workIdle.quietMs, 60000)
  assert.equal(old.workIdle.maxMs, 1800000)
  assert.deepEqual(input.placement.host, p.host)
  assert.equal(input.placement.asar, old.target.asar)
  assert.equal(input.placement.config, old.target.configSHA)
  assert.equal(input.placement.native.argv, input.placement.native.comm)
  const oldAppKind = p.oldAppKind ?? "owned-single-child-no-relaunch"
  assert.ok(["owned-single-child-no-relaunch", "launchd-parented"].includes(oldAppKind))
  const parent = oldAppKind === "launchd-parented" ? input.placement.parent : input.placement.keeper
  assert.ok(parent, "current native parent identity required")
  assert.equal(Number(input.placement.native.ppid), parent.pid)
  if (oldAppKind === "launchd-parented") {
    assert.equal(profile.kind, "laptop", "launchd-parented mode is Laptop-only")
    assert.equal(input.placement.keeper, null, "launchd-parented native has no owned keeper")
    assert.equal(parent.pid, 1)
    assert.equal(Number(parent.ppid), 0)
    assert.equal(parent.comm, "/sbin/launchd")
  }
  if (oldAppKind === "owned-single-child-no-relaunch") {
    assert.ok(parent.pid > 1)
    assert.equal(Number(parent.ppid), 1)
  }
  assert.equal(input.placement.devToolsActivePort, "ABSENT")
  assert.deepEqual(input.placement.l9229, [])
  assert.deepEqual(input.placement.guiLabels, [])
  assert.equal(input.placement.lease, false)
  assert.ok(input.placement.native.pid > 1)
  for (const process of [input.placement.native, parent]) assert.ok(process.startUTC)
  const suffix = profile.kind === "mini" ? "-mini" : ""
  const operation = `desktop-publish-${p.accepted.source.slice(0, 8)}${suffix}-v${p.attempt}`
  const jobID = profile.kind === "mini" ? `desktop-${p.accepted.source.slice(0, 8)}-mini-v${p.attempt}` : `desktop-${p.accepted.source.slice(0, 8)}-publish-v${p.attempt}`
  const stateRoot = path.dirname(old.state), deployBefore = profile.deploy, callerBefore = profile.caller
  if (profile.kind === "laptop") {
    assert.ok(path.isAbsolute(p.executorWorkspace))
    assert.equal(p.executorWorkspace, path.dirname(callerBefore.state), "caller state must stay in the adopted Setup workspace")
  }
  const callerState = profile.kind === "laptop" ? `${p.executorWorkspace}/normal-publication-caller-${p.accepted.release.replaceAll("-", "")}-v${p.attempt}` : `${stateRoot}/callers/${operation}`
  assert.equal(input.absence.host, p.host)
  for (const name of [...new Set([operation, jobID, p.accepted.source.slice(0, 8), path.basename(callerState)])]) {
    assert.ok(input.absence[name], `no exact absence proof for ${name}`)
    assert.ok(Object.values(input.absence[name]).every((items) => Array.isArray(items) && items.length === 0), `target exists: ${name}`)
  }
  for (const pin of Object.values(p.accepted.files)) assert.match(pin, /^[a-f0-9]{64}$/)
  const accepted = p.accepted.files, artifact = input.artifact
  assert.equal(artifact.native.asarSHA, accepted["Editspace.app/Contents/Resources/app.asar"])
  assert.equal(artifact.webTree["index.html"].sha256, accepted["web/index.html"])
  const target = { ...old.target, owner: p.owner, operation, source: p.accepted.source, release: p.accepted.release,
    asar: artifact.native.asarSHA, renderer: artifact.native.renderer, fromAsar: old.target.asar, fromRenderer: old.target.renderer }
  if (profile.kind === "laptop") Object.assign(target, { webIndexSHA: accepted["web/index.html"], webManifestSHA: accepted["web.sha256"], fromWebIndexSHA: old.target.webIndexSHA })
  const metadata = input.placement
  assert.deepEqual(JSON.parse(input.placementBytes), metadata)
  const placementSHA = hash(input.placementBytes)
  assert.equal(path.dirname(deployBefore), `${stateRoot}/code`)
  const bodies = Object.fromEntries(Object.entries(input.sources).filter(([name]) => !["source-pins.json", "runtime-plan.json", "publish.manifest.json", "publish.gui-closure.json", "publish.executor-entry.json", "caller-plan.json"].includes(name)))
  for (const [name, bytes] of Object.entries(bodies)) {
    assert.ok(safeName(name))
    assert.equal(hash(bytes), profile.sourcePins[name], `adopted source changed: ${name}`)
  }
  const programSHA = programFingerprint(profile, bodies)
  assert.equal(programSHA, profile.programSHA, "standing program fingerprint drift")
  assert.equal(input.runnerReview.schema, "desktop-runner-review/1")
  assert.equal(input.runnerReview.state, "approved")
  assert.equal(input.runnerReview.kind, profile.kind)
  assert.equal(input.runnerReview.programSHA, programSHA, "program fingerprint needs independent runner-change review")
  assert.equal(input.runnerReview.compilerSHA, input.compilerSHA, "compiler source needs independent review")
  assert.equal(input.runnerReview.ref, p.authority.runnerReview)
  const callerName = profile.kind === "laptop" ? "normal-publication/caller.py" : "caller.py"
  bodies[callerName] = Buffer.from(replaceOnce(replaceOnce(bodies[callerName].toString(), old.target.operation, operation), old.jobID, jobID))
  if (profile.kind === "laptop") bodies[callerName] = Buffer.from(replaceOnce(bodies[callerName].toString(), path.basename(callerBefore.state), path.basename(callerState)))
  if (profile.kind === "mini") bodies["normal-publication/shared.mjs"] = Buffer.from(replaceOnce(bodies["normal-publication/shared.mjs"].toString(), JSON.stringify(old.target), JSON.stringify(target)))
  const keeper = oldAppKind === "owned-single-child-no-relaunch" ? { contract: "normal-publication-single-child/1", script: `${deployBefore}/normal-publication/keeper.mjs`, scriptSHA: metadata.code["normal-publication/keeper.mjs"],
    request: `${old.state}/keeper-request.json`, requestSHA: metadata.opFiles["keeper-request.json"], result: `${old.state}/keeper.json`, resultSHA: metadata.opFiles["keeper.json"] } : undefined
  if (keeper) {
    keeper.argv = [old.node, keeper.script, keeper.request, keeper.requestSHA]
    assert.equal(keeper.argv.join(" "), metadata.keeper.argv)
    assert.equal(keeper.scriptSHA, profile.sourcePins["normal-publication/keeper.mjs"])
  }
  const listen = profile.kind === "laptop" ? "listen60302" : "listen63977"
  const oldApp = { kind: oldAppKind, timezone: "UTC", observed: {
    child: { pid: metadata.native.pid, ppid: Number(metadata.native.ppid), lstart: metadata.native.startUTC, exe: metadata.native.comm, asar: metadata.asar },
    parent: { pid: parent.pid, ppid: Number(parent.ppid), lstart: parent.startUTC, comm: parent.comm }, [listen]: [metadata.native.pid] }, ...(keeper ? { keeper } : {}) }
  if (profile.kind === "laptop") oldApp.nativeCommand = metadata.native.argv
  const identityName = profile.kind === "laptop" ? "normal-publication/old-app-identity.json" : "provenance/old-app.json"
  Object.assign(bodies, {
    [identityName]: Buffer.from(json({ schema: "desktop-old-app-identity/1", host: p.host, metadataSHA: placementSHA, ...oldApp })),
    "provenance/release-parameters.json": Buffer.from(json(p)), "provenance/placement-current.json": input.placementBytes,
    "provenance/standing-runner-review.json": Buffer.from(json(input.runnerReview)),
    "provenance/previous-terminal-journal.json": Buffer.from(json(input.previousJournal)),
    "provenance/host-guards.json": Buffer.from(json({ schema: "desktop-host-guards/1", host: p.host, observedAt: metadata.at, native: metadata.native, keeper: metadata.keeper, ...(oldAppKind === "launchd-parented" ? { parent } : {}), web: metadata.web ?? null,
      core: metadata.l4096, dashboard: metadata.l7777, gateway: metadata.l47120 ?? null, tools: metadata.helpers, configSHA: metadata.config, partitions: metadata.partitions,
      currentObservationRequired: true, workQuietMs: 60000, workWaitMaxMs: 1800000, personalAdmission: "current-required", coreExclusion: p.authority.coreExclusion })),
    "provenance/target-absence.json": Buffer.from(json(input.absence)), "provenance/accepted-artifact.txt": Buffer.from(artifact.provenance),
    [profile.kind === "laptop" ? "provenance/native-artifact-proof.json" : "provenance/native-artifact.json"]: Buffer.from(json(artifact.native)), "normal-publication/app-tree.json": Buffer.from(json(artifact.appTree)),
  })
  const priorPins = keeper ? { [keeper.script]: keeper.scriptSHA, [keeper.request]: keeper.requestSHA, [keeper.result]: keeper.resultSHA } : {}
  const prior = profile.kind === "laptop" ? laptopPrior(input, old, metadata, priorPins, bodies) : miniPrior(input, old, metadata, priorPins)
  if (profile.kind === "laptop") {
    assert.ok(p.helperCompatibility?.authority && p.helperCompatibility?.qualification, "retained helper requires qualified acceptance")
    assert.equal(hash(bodies["normal-publication/web-runtime.mjs"]), p.helperCompatibility.outputSHA)
    assert.equal(metadata.webIndex, old.target.webIndexSHA)
    assert.ok(input.executorProof)
    assert.equal(input.executorProof.current.fileSHA, metadata.execConfig.sha256)
    assert.equal(input.executorProof.current.normalEntrySHA, profile.plan.executorEntrySHA)
    assert.equal(input.executorProof.prior.normalEntrySHA, profile.plan.executorEntrySHA)
    assert.equal(input.executorProof.current.jobsCanonicalSHA, input.executorProof.prior.jobsCanonicalSHA)
    assert.deepEqual(input.executorProof.current.perJob, input.executorProof.prior.perJob)
    bodies["provenance/executor-jobs.json"] = Buffer.from(json(input.executorProof))
    bodies["provenance/helper-compatibility.json"] = Buffer.from(json(p.helperCompatibility))
    bodies["normal-publication/web-tree.json"] = Buffer.from(json(artifact.webTree))
    bodies["normal-publication/artifact.json"] = Buffer.from(json({ target, renderers: artifact.renderers, sourceRoot: artifact.root, appTreeSHA: hash(json(artifact.appTree)), webTreeSHA: hash(json(artifact.webTree)), receiptSHA: accepted["RECEIPT.md"], iconSHA: accepted["Editspace.app/Contents/Resources/icon.icns"], appNodes: Object.keys(artifact.appTree).length, webNodes: Object.keys(artifact.webTree).length, status: "accepted artifact; generated parameters" }))
    if (bodies[profile.targetFile]) bodies[profile.targetFile] = Buffer.from(json(target))
  }
  const sourcePins = Object.fromEntries(Object.entries(bodies).map(([name, bytes]) => [name, hash(bytes)]))
  const revision = `${profile.kind === "laptop" ? "normal-publication-v1" : "mini-publication-plain-v1"}-${hash(json({ compiler: input.compilerSHA, profile: input.profileSHA, parameters: p, sourcePins })).slice(0, 12)}`
  const deploy = `${stateRoot}/code/${revision}`, snapshot = `${input.output}/${revision}`
  const relocate = (value) => mapStrings(value, (value) => value.replaceAll(deployBefore, deploy))
  if (profile.runtimePlan) bodies["runtime-plan.json"] = Buffer.from(json(relocate(profile.runtimePlan)))
  bodies["source-pins.json"] = Buffer.from(json({ schema: "desktop-publication-source-pins/1", revision, target, files: sourcePins, standingProfileSHA: input.profileSHA, compilerSHA: input.compilerSHA }))
  const external = profile.kind === "laptop" ? { ...old.files } : Object.fromEntries(Object.entries(old.files).filter(([file]) => !file.startsWith(`${stateRoot}/`)))
  for (const [file, pin] of Object.entries(metadata.helpers)) {
    if (external[file] !== pin) assert.ok(profile.kind === "laptop" && file.endsWith("/es-laptop-exec") && p.authority.executorChange, `unapproved tool change: ${file}`)
    external[file] = pin
  }
  if (profile.kind === "laptop") external[path.resolve(path.dirname(metadata.native.comm), "../Resources/app.asar")] = target.fromAsar
  const files = { ...external, ...priorPins, ...Object.fromEntries(Object.entries(bodies).map(([name, bytes]) => [`${deploy}/${name}`, hash(bytes)])) }
  const coordinator = { role: "desktop-publisher", session: p.owner, executor: p.authority.executor, authority: p.authority.acceptance, standingProfileSHA: input.profileSHA, compilerSHA: input.compilerSHA }
  const manifest = { ...relocate(old), target, coordinator, jobID, state: `${stateRoot}/${operation}`, files,
    oldApp: { ...oldApp, receiptFile: `${deploy}/${identityName}`, receiptSHA: hash(bodies[identityName]) },
    artifact: { directory: `${stateRoot}/artifacts/${p.accepted.source}`, appTree: `${deploy}/normal-publication/app-tree.json`, ...(profile.kind === "laptop" ? { webTree: `${deploy}/normal-publication/web-tree.json` } : {}) } }
  if (profile.kind === "laptop") {
    manifest.authority = p.authority.acceptance
    manifest.webStart = { ...relocate(old.webStart), previous: prior, metadataFile: `${deploy}/provenance/placement-current.json`, metadataSHA: placementSHA }
    manifest.targetConfigWriterAssessment = { ...old.targetConfigWriterAssessment, source: target.source, asar: target.asar, review: p.authority.acceptance }
  }
  if (profile.kind === "mini") {
    manifest.profileIdentities = prior
    manifest.acceptance = { file: p.acceptance.file, sha256: p.acceptance.sha256, receiptSHA: accepted["RECEIPT.md"] }
  }
  const manifestPath = `${deploy}/publish.manifest.json`, closurePath = `${deploy}/publish.gui-closure.json`
  bodies["publish.manifest.json"] = Buffer.from(json(manifest))
  const manifestSHA = hash(bodies["publish.manifest.json"])
  bodies["publish.gui-closure.json"] = Buffer.from(json({ files: { ...files, [manifestPath]: manifestSHA } }))
  const closureSHA = hash(bodies["publish.gui-closure.json"])
  const argv = (profile.kind === "laptop" ? profile.plan.argv : callerBefore.argv).map((value) => value === old.target.operation ? operation : value === old.jobID ? jobID : value === profile.manifestSHA ? manifestSHA : relocate(value))
  const result = profile.kind === "laptop"
    ? laptopPlans({ input, profile, p, manifest, manifestSHA, closureSHA, manifestPath, closurePath, target, jobID, argv, bodies, sourcePins, deploy, snapshot, revision, callerName, callerState, coordinator })
    : miniPlans({ input, profile, p, manifest, manifestSHA, closureSHA, manifestPath, closurePath, target, jobID, argv, bodies, deploy, snapshot, revision, callerState })
  const parametersSHA = hash(json(p))
  const index = { schema: "desktop-generated-packet/1", state: "source-ready", purpose: p.purpose, physicalScopeIssued: false, host: p.host, release: p.accepted.release, source: p.accepted.source, operation, jobID, revision,
    compilerSHA: input.compilerSHA, runnerProfileSHA: input.profileSHA, programSHA, parametersSHA, parametersSourceSHA: input.parametersSourceSHA, executor: p.authority.executor, terminal: null, ...result,
    terminalRecord: { schema: "es-desktop-install/1", registryHost: "murtaza-mac-mini", registry: path.join(path.dirname(stateRoot), "es-desktop-installs", `${p.host}.jsonl`), host: p.host, packet: revision, job_id: jobID, writer: "mac-mini-setup" },
    guardPolicy: { inheritedRunner: profile.manifestSHA, predecessorPhase: input.previousJournal.state, currentGuardsRequired: true, workIdle: old.workIdle, personalAdmission: "current-required", preservation: "unchanged", oneShot: true, automaticReplay: false, legacyClosurePolicy: profile.kind === "laptop" ? "retain adopted ancestors; no pruning" : "adopted Mini dependency set" },
    files: Object.fromEntries(Object.entries(bodies).map(([name, bytes]) => [name, hash(bytes)])) }
  bodies["packet-index.json"] = Buffer.from(json(index))
  return { revision, snapshot, deploy, bodies, index, indexSHA: hash(bodies["packet-index.json"]) }
}

function laptopPrior(input, old, metadata, priorPins, bodies) {
  const request = JSON.parse(input.previousRequestBytes)
  assert.deepEqual(request.target, old.target)
  assert.equal(hash(input.previousRequestBytes), metadata.opFiles["owned-web-request.json"])
  assert.equal(input.previousJournal.operation, old.target.operation)
  assert.equal(input.previousJournal.cleanup, "confirmed")
  assert.ok(input.previousJournal.effects.some((effect) => effect.name === "web" && effect.state === "observed"))
  if (input.previousJournal.state !== "client-loaded") assert.ok(input.parameters.authority.priorDisposition, "unknown predecessor needs DD disposition")
  const inputs = { manifest: { file: `${input.profile.deploy}/publish.manifest.json`, sha256: input.profile.manifestSHA }, tree: { file: old.artifact.webTree, sha256: metadata.code["normal-publication/web-tree.json"] },
    ...Object.fromEntries(Object.entries({ journal: "journal.json", request: "owned-web-request.json", receipt: "owned-web.json", spawned: "web-spawned.json", started: "web-started.json", served: "served-web.json" }).map(([name, file]) => [name, { file: `${old.state}/${file}`, sha256: metadata.opFiles[file] }])) }
  for (const item of Object.values(inputs)) priorPins[item.file] = item.sha256
  assert.equal(request.root, `${old.artifact.directory}/web`)
  assert.equal(request.indexSHA, old.target.webIndexSHA)
  assert.deepEqual(request.tree, JSON.parse(input.sources["normal-publication/web-tree.json"]))
  bodies["provenance/previous-owned-web.json"] = input.previousRequestBytes
  const previous = { schema: "desktop-owned-web-continuation/1", origin: "http://127.0.0.1:3181", identity: { pid: metadata.web.pid, start: metadata.web.startUTC }, ppid: 1,
    root: `${old.artifact.directory}/web`, inputs, operation: old.target.operation, exitFile: `${old.state}/web-exit.json`, argv: [old.node, old.webStart.script, inputs.request.file, inputs.request.sha256] }
  assert.equal(previous.argv.join(" "), metadata.web.argv)
  const trees = [request.tree], roots = new Set([request.root])
  for (let item = request.retainedWeb; item; item = item.previous) {
    assert.ok(trees.length < 16 && path.isAbsolute(item.root) && !roots.has(item.root))
    roots.add(item.root)
    trees.push(item.tree)
  }
  const known = new Map()
  for (const tree of [input.artifact.webTree, ...trees]) for (const [name, file] of Object.entries(tree)) if (name.startsWith("assets/") && file.type === "file") {
    if (known.has(name)) assert.equal(known.get(name), file.sha256, `asset collision: ${name}`)
    known.set(name, file.sha256)
  }
  return previous
}

function miniPrior(input, old, metadata, pins) {
  const identities = Object.fromEntries(Object.entries(metadata.partitions).map(([file, info]) => {
    assert.deepEqual([info.uid, info.gid, info.mode], [502, 20, "0o700"])
    return [file, { dev: info.dev, ino: info.ino }]
  }))
  assert.deepEqual(identities, old.profileIdentities)
  assert.deepEqual(metadata.partitionNames, ["editspace"])
  assert.deepEqual(metadata.nativeListeners, ["127.0.0.1:63977"])
  pins[`${input.profile.deploy}/normal-publication/shared.mjs`] = old.files[`${input.profile.deploy}/normal-publication/shared.mjs`]
  for (const file of ["journal.json", "native-started.json", "supervisor-started.json"]) pins[`${old.state}/${file}`] = metadata.opFiles[file]
  return identities
}

function laptopPlans(c) {
  const pins = Object.fromEntries(c.argv.filter((value) => path.isAbsolute(value)).map((file) => [file, file === c.manifestPath ? c.manifestSHA : file === c.closurePath ? c.closureSHA : c.manifest.files[file]]))
  assert.ok(Object.values(pins).every((pin) => /^[a-f0-9]{64}$/.test(pin)))
  c.bodies["publish.executor-entry.json"] = Buffer.from(json({ host: c.p.host, jobs: { "desktop-normal-publish": { argv: c.argv, pins, timeout_s: 2160, requires_gui: true } } }))
  const entrySHA = hash(c.bodies["publish.executor-entry.json"])
  const caller = { ...c.profile.caller, owner: c.p.authority.executor, caller: `${c.snapshot}/${c.callerName}`, state: c.callerState, jobID: c.jobID, operation: c.target.operation,
    argv: ["/usr/bin/ssh", "-o", "BatchMode=yes", "laptop-exec", "run", "desktop-normal-publish", c.jobID], remoteEntrySHA: entrySHA, remoteManifestSHA: c.manifestSHA, remoteClosureSHA: c.closureSHA, remoteArgv: c.argv, remotePins: pins }
  caller.pins = { ...Object.fromEntries(Object.entries(c.profile.caller.pins).filter(([file]) => file !== c.profile.caller.caller)), [caller.caller]: hash(c.bodies[c.callerName]) }
  c.bodies["caller-plan.json"] = Buffer.from(json(caller))
  const sourceNames = Object.keys(c.bodies).filter((name) => !["publish.manifest.json", "publish.gui-closure.json", "publish.executor-entry.json", "caller-plan.json"].includes(name))
  const sourceStage = { ...c.profile.sourceStage, status: "generated source-only; DD scope/current guards required", directory: c.deploy, revision: c.revision, sourcePinsSHA: hash(c.bodies["source-pins.json"]), files: sourceNames.map((name) => ({ source: `${c.snapshot}/${name}`, target: `${c.deploy}/${name}`, sha256: hash(c.bodies[name]) })) }
  c.bodies["source-stage-plan.json"] = Buffer.from(json(sourceStage))
  const metadataStage = { ...c.profile.metadataStage, directory: c.deploy, sourceStagePlanSHA: hash(c.bodies["source-stage-plan.json"]), files: ["publish.manifest.json", "publish.gui-closure.json", "publish.executor-entry.json"].map((name) => ({ source: `${c.snapshot}/${name}`, target: `${c.deploy}/${name}`, sha256: hash(c.bodies[name]) })) }
  c.bodies["metadata-stage-plan.json"] = Buffer.from(json(metadataStage))
  const a = c.input.artifact
  const artifactStage = { ...c.profile.artifactStage, target: c.target, source: a.root, destination: c.manifest.artifact.directory, status: "accepted bytes; generated copy-only plan",
    members: { "Editspace.app": { tree: `${c.snapshot}/normal-publication/app-tree.json`, sha256: hash(json(a.appTree)), nodes: Object.keys(a.appTree).length }, web: { tree: `${c.snapshot}/normal-publication/web-tree.json`, sha256: hash(json(a.webTree)), nodes: Object.keys(a.webTree).length } },
    metadata: ["web.sha256", "RECEIPT.md"].map((name) => ({ name, sha256: c.p.accepted.files[name] })) }
  c.bodies["artifact-stage-plan.json"] = Buffer.from(json(artifactStage))
  const callerSHA = hash(c.bodies["caller-plan.json"])
  const plan = { ...c.profile.plan, status: "generated source-only; DD scope/current guards required", revision: c.revision, snapshot: c.snapshot, deploy: c.deploy, coordinator: c.coordinator, target: c.target, renderers: a.renderers, jobID: c.jobID,
    sourcePinsSHA: hash(c.bodies["source-pins.json"]), sourceStagePlanSHA: hash(c.bodies["source-stage-plan.json"]), metadataStagePlanSHA: hash(c.bodies["metadata-stage-plan.json"]), artifactStagePlanSHA: hash(c.bodies["artifact-stage-plan.json"]), manifestTarget: c.manifestPath, manifestSHA: c.manifestSHA, closureTarget: c.closurePath, closureSHA: c.closureSHA, executorEntrySHA: entrySHA, argv: c.argv, callerPlanSHA: callerSHA,
    callerStartArgv: [caller.python, "-I", "-B", caller.caller, "start", `${c.snapshot}/caller-plan.json`, callerSHA], oldApp: c.manifest.oldApp, webStart: c.manifest.webStart,
    acceptance: { file: c.p.acceptance.file, sha256: c.p.acceptance.sha256, receiptSHA: c.p.accepted.files["RECEIPT.md"], iconSHA: c.p.accepted.files["Editspace.app/Contents/Resources/icon.icns"], webManifestFiles: Object.values(a.webTree).filter((entry) => entry.type === "file").length },
    executorConfig: { baseSHA: c.input.placement.execConfig.sha256, previousEntrySHA: c.input.placement.execConfig.normalEntry }, runAdmission: { state: "pending-exact-scope", physicalScopeIssued: false, source: c.p.authority.acceptance }, preservation: "unchanged adopted runner; current seal/hydration/Work/Personal guards required", evidence: c.p.authority.acceptance }
  c.bodies["exact-job-plan.json"] = Buffer.from(json(plan))
  return { plan: "exact-job-plan.json", planSHA: hash(c.bodies["exact-job-plan.json"]), manifestSHA: c.manifestSHA, closureSHA: c.closureSHA, callerPlanSHA: callerSHA, executorEntrySHA: entrySHA }
}

function miniPlans(c) {
  const caller = { ...mapStrings(c.profile.caller, (value) => value.replaceAll(c.profile.deploy, c.deploy)), target: c.target, jobID: c.jobID, argv: c.argv, state: c.callerState,
    pins: { ...c.manifest.files, [c.manifestPath]: c.manifestSHA, [c.closurePath]: c.closureSHA }, manifestSHA: c.manifestSHA, closureSHA: c.closureSHA }
  c.bodies["caller-plan.json"] = Buffer.from(json(caller))
  const callerSHA = hash(c.bodies["caller-plan.json"])
  const stage = { revision: c.revision, snapshot: c.snapshot, deploy: c.deploy, target: c.target, jobID: c.jobID, status: "generated source-only; Laptop terminal+DD, current scope/guards required",
    files: Object.entries(c.bodies).map(([name, bytes]) => ({ source: `${c.snapshot}/${name}`, target: `${c.deploy}/${name}`, sha256: hash(bytes), mode: fileMode(name) })),
    artifact: { source: c.input.artifact.root, destination: c.manifest.artifact.directory, appTreeSHA: hash(c.bodies["normal-publication/app-tree.json"]), nodes: Object.keys(c.input.artifact.appTree).length },
    caller: { program: c.manifest.python, argv: ["-I", `${c.deploy}/caller.py`, `${c.deploy}/caller-plan.json`, callerSHA, "--start"] }, manifestSHA: c.manifestSHA, closureSHA: c.closureSHA, callerPlanSHA: callerSHA }
  c.bodies["stage-plan.json"] = Buffer.from(json(stage))
  return { plan: "stage-plan.json", planSHA: hash(c.bodies["stage-plan.json"]), manifestSHA: c.manifestSHA, closureSHA: c.closureSHA, callerPlanSHA: callerSHA }
}

export function fileMode(name) {
  if (name.startsWith("runtime/")) return "0555"
  if (["publish.manifest.json", "publish.gui-closure.json", "publish.executor-entry.json", "caller-plan.json"].includes(name)) return "0400"
  return "0444"
}

export function safeName(name) {
  return name !== "." && !name.includes("\0") && !name.includes("\\") && !path.isAbsolute(name) && path.posix.normalize(name) === name && !name.split("/").includes("..") && !/frame-proof|postlaunch-frames|frame-request-guard|OOPIF/i.test(name)
}

export function programFingerprint(profile, sources) {
  const programs = Object.fromEntries(Object.entries(sources).filter(([name]) => /\.(?:mjs|js|cjs|py)$/.test(name)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, bytes]) => {
    const caller = profile.kind === "laptop" ? "normal-publication/caller.py" : "caller.py"
    if (name === caller) {
      const body = replaceOnce(replaceOnce(bytes.toString(), profile.manifest.target.operation, "<OPERATION>"), profile.manifest.jobID, "<JOB>")
      return [name, hash(profile.kind === "laptop" ? replaceOnce(body, path.basename(profile.caller.state), "<CALLER_STATE>") : body)]
    }
    if (name === "normal-publication/shared.mjs" && profile.kind === "mini") return [name, hash(replaceOnce(bytes.toString(), JSON.stringify(profile.manifest.target), "<TARGET>"))]
    return [name, hash(bytes)]
  }))
  return hash(json(programs))
}

function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length, 2, `expected one parameter slot: ${before}`)
  return text.replace(before, after)
}

function mapStrings(value, change) {
  if (typeof value === "string") return change(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [change(key), mapStrings(item, change)]))
  return value
}
