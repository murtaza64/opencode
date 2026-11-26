import { hash, json } from "./artifact.mjs"
import { programFingerprint } from "./packet.mjs"

// Decoy runner/data graph; no live files, listeners or transport.
export function fixture(kind, output) {
  const host = kind === "laptop" ? "murtaza-macbook-pro" : "murtaza-mac-mini"
  const stateRoot = `/decoy/${kind}/state`, deploy = `${stateRoot}/code/adopted`
  const oldTarget = { operation: "desktop-publish-aaaaaaaa-v1", owner: "ses_previous", host, release: "2026-11-04.1", source: "a".repeat(40),
    asar: hash("old-asar"), renderer: "/assets/index-old.js", fromAsar: hash("older-asar"), fromRenderer: "/assets/index-older.js", configSHA: hash("config") }
  if (kind === "laptop") Object.assign(oldTarget, { webIndexSHA: hash("old-index"), webManifestSHA: hash("old-web"), fromWebIndexSHA: hash("older-index") })
  const oldJob = "desktop-aaaaaaaa-publish-v1", keeperRequest = hash("keeper-request"), keeperResult = hash("keeper-result")
  const oldWebTree = { ".": { type: "dir", mode: 0o755 }, "index.html": { type: "file", sha256: oldTarget.webIndexSHA, size: 3, mode: 0o644 } }
  const callerState = "/decoy/setup/private/normal-publication-caller-old-v1"
  const sources = {
    "normal-publication/native.mjs": Buffer.from("export const preserve = 'strict; miniCookieAdditions: true; cookieCountsNonLoss: true'\n"),
    "normal-publication/keeper.mjs": Buffer.from("export const keeper = 'single-child'\n"),
    "normal-publication/runner.mjs": Buffer.from("export const admission = 'Work quiet 60000 + current Personal + seal + hydrate + compare'\n"),
    "normal-publication/shared.mjs": Buffer.from(kind === "mini" ? `export const requireTarget = target => assert.deepEqual(target, ${JSON.stringify(oldTarget)})\n` : "export const requireTarget = target => target\n"),
    "normal-publication/web-runtime.mjs": Buffer.from("export const helper = 'adopted'\n"),
    "normal-publication/web-tree.json": Buffer.from(json(oldWebTree)),
    "normal-publication/release-723c0f66.json": Buffer.from(json(oldTarget)),
    "runtime/node_modules/runner/index.js": Buffer.from("module.exports = 'pinned-runtime'\n"),
  }
  const callerName = kind === "laptop" ? "normal-publication/caller.py" : "caller.py"
  sources[callerName] = Buffer.from(`OP = '${oldTarget.operation}'\nJOB = '${oldJob}'\n${kind === "laptop" ? `STATE = '${callerState.split("/").at(-1)}'\n` : ""}`)
  const nativeCommand = "/decoy/Applications/Editspace.app/Contents/MacOS/Editspace"
  const old = { target: oldTarget, jobID: oldJob, state: `${stateRoot}/${oldTarget.operation}`, node: "/decoy/tools/node", python: "/decoy/tools/python", native: `${deploy}/normal-publication/native.mjs`, entry: `${deploy}/normal-publication/entry.mjs`,
    files: { "/decoy/tools/node": hash("node"), "/decoy/tools/python": hash("python"), "/decoy/tools/es-gui-job": hash("gui-job"), [`${deploy}/normal-publication/keeper.mjs`]: hash(sources["normal-publication/keeper.mjs"]), [`${deploy}/normal-publication/shared.mjs`]: hash(sources["normal-publication/shared.mjs"]), [`${deploy}/normal-publication/web-tree.json`]: hash(sources["normal-publication/web-tree.json"]) },
    artifact: { directory: `${stateRoot}/artifacts/${oldTarget.source}`, appTree: `${deploy}/normal-publication/app-tree.json`, webTree: `${deploy}/normal-publication/web-tree.json` },
    oldApp: { keeper: { script: `${deploy}/normal-publication/keeper.mjs` } },
    workIdle: { quietMs: 60000, maxMs: 1800000 }, trustedAncestors: {}, trustedWritableFiles: {},
    webStart: { schema: "desktop-owned-web-start/1", initial: "owned-transition", origin: "http://127.0.0.1:3181", script: `${deploy}/normal-publication/owned-web.mjs` },
    profileIdentities: { "/decoy/profile": { dev: 1, ino: 2 } }, targetConfigWriterAssessment: { scope: "unchanged config" }, qualification: { journalCookieField: "cookieCountsNonLoss" } }
  const manifestBytes = Buffer.from(json(old)), manifestSHA = hash(manifestBytes)
  const argv = [old.python, "-I", "/decoy/tools/es-gui-job", "--label", oldJob, "--closure", `${deploy}/publish.gui-closure.json`, "--operation", oldTarget.operation, "--job-id", oldJob, "--", old.python, "-I", `${deploy}/normal-publication/native.mjs`, `${deploy}/publish.manifest.json`, manifestSHA]
  const caller = { schema: "desktop-publication-caller/1", caller: `${deploy}/${callerName}`, python: old.python, state: callerState, jobID: oldJob, operation: oldTarget.operation,
    argv, pins: { [old.python]: hash("python"), [`${deploy}/${callerName}`]: hash(sources[callerName]) }, manifestSHA, executionTimeout_s: 2160, callerTimeout_s: 2220, sshTimeout_s: 2215 }
  const profile = { schema: "desktop-standing-runner/1", kind, manifest: old, manifestSHA, deploy, caller,
    sourcePins: Object.fromEntries(Object.entries(sources).map(([name, bytes]) => [name, hash(bytes)])), adoption: { state: "adopted", evidence: "fixture terminal" }, review: "fixture reviewed runner",
    plan: { argv, executorEntrySHA: hash("old-entry") }, sourceStage: {}, metadataStage: {}, artifactStage: {}, targetFile: "normal-publication/release-723c0f66.json",
    runtimePlan: { target: `${deploy}/runtime`, files: [{ target: `${deploy}/runtime/node_modules/runner/index.js`, sha256: hash(sources["runtime/node_modules/runner/index.js"]) }] } }
  profile.programSHA = programFingerprint(profile, sources)
  const newFiles = { "Editspace.app/Contents/Resources/app.asar": hash("new-asar"), "Editspace.app/Contents/Resources/icon.icns": hash("icon"), "web/index.html": hash("new-index"), "web.sha256": hash("web-manifest"), "RECEIPT.md": hash("receipt"), "PROVENANCE.txt": hash("provenance") }
  const artifact = { root: "/decoy/artifact", native: { asarSHA: newFiles["Editspace.app/Contents/Resources/app.asar"], renderer: "/assets/index-new.js" },
    appTree: { ".": { type: "dir", mode: 0o755 } }, webTree: { ".": { type: "dir", mode: 0o755 }, "index.html": { type: "file", mode: 0o644, sha256: newFiles["web/index.html"] } }, provenance: Buffer.from("fixture-provenance"), renderers: { native: "/assets/index-new.js", web: "/assets/index-new-web.js" } }
  const previousRequest = { target: oldTarget, root: `${old.artifact.directory}/web`, tree: oldWebTree, indexSHA: oldTarget.webIndexSHA, port: 3181, opencode: "http://127.0.0.1:4096", dashboard: "http://127.0.0.1:7777", result: `${old.state}/owned-web.json` }
  const previousRequestBytes = Buffer.from(json(previousRequest))
  const placement = { host, asar: oldTarget.asar, config: oldTarget.configSHA,
    native: { pid: 120, ppid: "119", startUTC: "fixture-native-start", comm: nativeCommand, argv: nativeCommand },
    keeper: { pid: 119, ppid: "1", startUTC: "fixture-keeper-start", comm: old.node, argv: `${old.node} ${deploy}/normal-publication/keeper.mjs ${old.state}/keeper-request.json ${keeperRequest}` },
    web: { pid: 110, startUTC: "fixture-web-start", argv: `${old.node} ${old.webStart.script} ${old.state}/owned-web-request.json ${hash(previousRequestBytes)}` }, webIndex: oldTarget.webIndexSHA ?? null,
    code: { "normal-publication/keeper.mjs": hash(sources["normal-publication/keeper.mjs"]), "normal-publication/web-tree.json": hash(sources["normal-publication/web-tree.json"]) },
    opFiles: { "keeper-request.json": keeperRequest, "keeper.json": keeperResult, "owned-web-request.json": hash(previousRequestBytes), "journal.json": hash("journal"), "owned-web.json": hash("web-result"), "web-spawned.json": hash("web-spawned"), "web-started.json": hash("web-started"), "served-web.json": hash("web-served"), "native-started.json": hash("native-started"), "supervisor-started.json": hash("supervisor-started") },
    helpers: { "/decoy/tools/node": hash("node"), "/decoy/tools/python": hash("python"), "/decoy/tools/es-gui-job": hash("gui-job") }, execConfig: { sha256: hash("executor-config"), normalEntry: profile.plan.executorEntrySHA },
    devToolsActivePort: "ABSENT", l9229: [], guiLabels: [], lease: false, partitionNames: ["editspace"], partitions: { "/decoy/profile": { dev: 1, ino: 2, uid: 502, gid: 20, mode: "0o700" } }, nativeListeners: ["127.0.0.1:63977"], l4096: [{ pid: "900", startUTC: "fixture-core-start" }], l7777: [{ pid: "901", startUTC: "fixture-dashboard-start" }] }
  const source = "b".repeat(40), operation = `desktop-publish-bbbbbbbb${kind === "mini" ? "-mini" : ""}-v1`, job = `desktop-bbbbbbbb-${kind === "mini" ? "mini" : "publish"}-v1`
  const absence = { host, [operation]: { state: [], apps: [], labels: [], reservations: [] }, [job]: { state: [], apps: [], labels: [], reservations: [] }, bbbbbbbb: { state: [], apps: [], labels: [], reservations: [] }, "normal-publication-caller-20261105.1-v1": { state: [], apps: [], labels: [], reservations: [] } }
  const profileSHA = hash("fixture-profile")
  const parameters = { schema: "desktop-release-parameters/1", purpose: "verification", host, owner: "ses_publisher", attempt: 1, runnerProfileSHA: profileSHA,
    accepted: { source, release: "2026-11-05.1", directory: artifact.root, files: newFiles }, acceptance: { file: "/decoy/acceptance.json", sha256: hash("acceptance") },
    authority: { acceptance: "fixture DD acceptance", runnerReview: "fixture review", coreExclusion: "fixture exclusion", perf: "fixture permit", executor: "ses_setup", scopeOwner: "desktop-delivery" },
    executorWorkspace: "/decoy/setup/private", helperCompatibility: { outputSHA: hash(sources["normal-publication/web-runtime.mjs"]), authority: "fixture DD compatibility", qualification: "fixture retained helper; not exact new source" } }
  const executor = { fileSHA: placement.execConfig.sha256, normalEntrySHA: profile.plan.executorEntrySHA, jobsCanonicalSHA: hash("jobs"), perJob: { "desktop-normal-publish": hash("job") } }
  return { profile, parameters, profileSHA, parametersSourceSHA: hash(json(parameters)), compilerSHA: hash("fixture-compiler"), runnerReview: { schema: "desktop-runner-review/1", state: "approved", kind, programSHA: profile.programSHA, compilerSHA: hash("fixture-compiler"), ref: parameters.authority.runnerReview }, sources, manifestBytes, artifact, placement, placementBytes: Buffer.from(json(placement)), absence, previousRequestBytes,
    previousJournal: { operation: oldTarget.operation, jobID: oldJob, manifestSHA, state: "client-loaded", cleanup: "confirmed", effects: [{ name: "web", state: "observed" }] }, executorProof: { current: executor, prior: { ...executor } }, output }
}
